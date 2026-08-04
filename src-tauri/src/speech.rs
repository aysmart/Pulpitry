//! Supervises the speech pipeline.
//!
//! One "session" is a Node sidecar process plus a cpal capture thread feeding
//! its stdin. The supervisor keeps a session alive for as long as the operator
//! wants to be listening: if the sidecar dies, or Azure drops the connection
//! past the point the sidecar can recover on its own, the session is rebuilt
//! with a backoff. The app itself is never taken down with it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver as StdReceiver};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::audio;
use crate::detect::Detector;
use crate::settings;

pub const EVENT_INTERIM: &str = "transcript:interim";
pub const EVENT_FINAL: &str = "transcript:final";
pub const EVENT_STATUS: &str = "speech:status";

const SIDECAR: &str = "pulpitry-speech";
const BACKOFF_START: Duration = Duration::from_millis(800);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    /// idle | starting | listening | reconnecting | error
    pub state: String,
    pub detail: Option<String>,
    pub device: Option<String>,
}

impl SpeechStatus {
    fn idle() -> Self {
        Self { state: "idle".into(), detail: None, device: None }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptPayload {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

struct Session {
    /// The supervisor generation that created this session, so a superseded
    /// supervisor cannot tear down the session that replaced its own.
    generation: u64,
    child: Arc<Mutex<Option<CommandChild>>>,
    audio_stop: Arc<AtomicBool>,
}

pub struct SpeechManager {
    app: AppHandle,
    detector: Arc<Detector>,
    /// Whether the operator wants to be listening right now.
    desired: AtomicBool,
    /// Bumped on every start/stop so a superseded supervisor exits quietly
    /// instead of racing the one that replaced it.
    generation: AtomicU64,
    status: Mutex<SpeechStatus>,
    session: Mutex<Option<Session>>,
}

impl SpeechManager {
    pub fn new(app: AppHandle, detector: Arc<Detector>) -> Self {
        Self {
            app,
            detector,
            desired: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            status: Mutex::new(SpeechStatus::idle()),
            session: Mutex::new(None),
        }
    }

    pub fn status(&self) -> SpeechStatus {
        self.status.lock().clone()
    }

    pub fn start(self: &Arc<Self>) -> Result<()> {
        // Already listening: starting again is a no-op, not an error.
        if self.desired.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move { manager.supervise(generation).await });
        Ok(())
    }

    pub fn stop(&self) {
        // Half a sentence left over from this service would otherwise be
        // stitched onto the first words of the next one.
        self.detector.reset();
        self.desired.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.teardown();
        self.set_status("idle", None, None);
    }

    fn is_current(&self, generation: u64) -> bool {
        self.desired.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }

    fn set_status(&self, state: &str, detail: Option<String>, device: Option<String>) {
        let next = SpeechStatus { state: state.into(), detail, device };
        {
            let mut current = self.status.lock();
            if *current == next {
                return;
            }
            *current = next.clone();
        } // guard released before emitting
        let _ = self.app.emit(EVENT_STATUS, next);
    }

    async fn supervise(self: Arc<Self>, generation: u64) {
        let mut backoff = BACKOFF_START;

        while self.is_current(generation) {
            self.set_status("starting", None, None);

            match self.spawn_session(generation) {
                Ok((events, device)) => {
                    self.set_status("listening", None, Some(device));
                    backoff = BACKOFF_START;
                    self.pump(generation, events).await;
                    self.teardown_generation(generation);
                    if !self.is_current(generation) {
                        break;
                    }
                    self.set_status(
                        "reconnecting",
                        Some("Transcription stopped unexpectedly — reconnecting".into()),
                        None,
                    );
                }
                Err(err) => {
                    self.teardown_generation(generation);
                    if !self.is_current(generation) {
                        break;
                    }
                    // A missing key or region will not fix itself on a retry, so
                    // surface it and stop rather than loop against the operator.
                    if is_fatal(&err) {
                        self.desired.store(false, Ordering::SeqCst);
                        self.set_status("error", Some(err.to_string()), None);
                        return;
                    }
                    self.set_status("reconnecting", Some(err.to_string()), None);
                }
            }

            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }

        self.teardown_generation(generation);
        // A fatal sidecar message clears `desired` on its way past, so check
        // before overwriting — the operator needs to keep reading why it quit.
        let failed = self.status.lock().state == "error";
        if !self.desired.load(Ordering::SeqCst) && !failed {
            self.set_status("idle", None, None);
        }
    }

    /// Starts the sidecar and the capture thread. Returns the sidecar's event
    /// stream and the name of the device actually opened.
    fn spawn_session(
        &self,
        generation: u64,
    ) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, String)> {
        let settings = settings::load(&self.app)?;
        let key = settings::load_azure_key()?
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| anyhow!("FATAL: Add your Azure Speech key in Settings to start transcribing."))?;
        if settings.azure_region.trim().is_empty() {
            return Err(anyhow!("FATAL: Set your Azure Speech region in Settings to start transcribing."));
        }

        // The key goes over the environment rather than argv, so it never shows
        // up in the process list.
        let env = HashMap::from([
            ("PULPITRY_AZURE_KEY".to_string(), key),
            ("PULPITRY_AZURE_REGION".to_string(), settings.azure_region.clone()),
            ("PULPITRY_LANGUAGE".to_string(), settings.language.clone()),
            ("PULPITRY_SAMPLE_RATE".to_string(), audio::TARGET_SAMPLE_RATE.to_string()),
        ]);

        let (events, child) = self
            .app
            .shell()
            .sidecar(SIDECAR)
            .map_err(|e| anyhow!("could not locate the speech sidecar: {e}"))?
            .envs(env)
            .spawn()
            .map_err(|e| anyhow!("could not start the speech sidecar: {e}"))?;

        let child = Arc::new(Mutex::new(Some(child)));
        let audio_stop = Arc::new(AtomicBool::new(false));

        // Bounded so a stalled sidecar drops audio instead of building an
        // ever-growing backlog, which would show up as runaway transcript lag.
        let (tx, rx) = sync_channel::<Vec<i16>>(64);

        let device = match audio::start_capture(
            settings.input_device_id.clone(),
            tx,
            Arc::clone(&audio_stop),
        ) {
            Ok(device) => device,
            Err(err) => {
                let spawned = child.lock().take();
                if let Some(spawned) = spawned {
                    let _ = spawned.kill();
                }
                return Err(err);
            }
        };

        spawn_stdin_writer(Arc::clone(&child), rx, Arc::clone(&audio_stop));
        *self.session.lock() = Some(Session { generation, child, audio_stop });

        Ok((events, device))
    }

    /// Drains sidecar output until it terminates or the session is superseded.
    async fn pump(&self, generation: u64, mut events: tauri::async_runtime::Receiver<CommandEvent>) {
        let mut pending = String::new();

        while let Some(event) = events.recv().await {
            if !self.is_current(generation) {
                return;
            }
            match event {
                CommandEvent::Stdout(bytes) => {
                    pending.push_str(&String::from_utf8_lossy(&bytes));
                    self.drain_messages(&mut pending);
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim();
                    if !line.is_empty() {
                        eprintln!("[sidecar] {line}");
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[sidecar] error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[sidecar] terminated: {payload:?}");
                    return;
                }
                _ => {}
            }
        }
    }

    /// The shell plugin may hand us whole lines (newline stripped) or raw
    /// chunks, so handle both: split on newlines when present, and otherwise
    /// accept the buffer as soon as it parses as a complete JSON message.
    fn drain_messages(&self, pending: &mut String) {
        while let Some(index) = pending.find('\n') {
            let line: String = pending.drain(..=index).collect();
            self.handle_message(line.trim());
        }
        if !pending.is_empty() {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(pending.trim()) {
                self.dispatch(&value);
                pending.clear();
            }
        }
    }

    fn handle_message(&self, line: &str) {
        if line.is_empty() {
            return;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => self.dispatch(&value),
            Err(_) => eprintln!("[sidecar] non-JSON output: {line}"),
        }
    }

    fn dispatch(&self, message: &serde_json::Value) {
        let kind = message.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        let text = message.get("text").and_then(|v| v.as_str()).unwrap_or_default();

        match kind {
            "recognizing" if !text.is_empty() => {
                // Detect against speech as it is being said, not only once
                // Azure decides the speaker has stopped.
                self.detector.on_interim(text);
                let _ = self.app.emit(
                    EVENT_INTERIM,
                    TranscriptPayload { text: text.to_string(), offset_ms: None, duration_ms: None },
                );
            }
            "recognized" if !text.is_empty() => {
                // Detection runs off-thread; the transcript must not wait on it.
                self.detector.on_final(text);
                let _ = self.app.emit(
                    EVENT_FINAL,
                    TranscriptPayload {
                        text: text.to_string(),
                        offset_ms: message.get("offsetMs").and_then(|v| v.as_u64()),
                        duration_ms: message.get("durationMs").and_then(|v| v.as_u64()),
                    },
                );
            }
            "listening" => {
                let device = self.status.lock().device.clone();
                self.set_status("listening", None, device);
            }
            "reconnecting" => {
                let detail = message.get("message").and_then(|v| v.as_str()).map(str::to_string);
                self.set_status("reconnecting", detail, None);
            }
            "error" => {
                let detail = message
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("The speech service reported an error")
                    .to_string();
                eprintln!("[sidecar] {detail}");
                // A rejected key or malformed region will fail identically on
                // every retry, so stop rather than reconnect in a loop.
                if message.get("fatal").and_then(|v| v.as_bool()).unwrap_or(false) {
                    self.desired.store(false, Ordering::SeqCst);
                }
                self.set_status("error", Some(detail), None);
            }
            _ => {}
        }
    }

    /// Tears down whatever session is current. Only `stop` should use this —
    /// a supervisor must not reach past its own generation.
    fn teardown(&self) {
        let session = self.session.lock().take();
        Self::end(session);
    }

    /// Tears the session down only if it is the one this generation created.
    ///
    /// Without the check, a stop-then-start (changing the microphone mid-
    /// service does exactly that) lets the outgoing supervisor wake up after
    /// the replacement has already registered its session, and kill it.
    fn teardown_generation(&self, generation: u64) {
        let session = {
            let mut guard = self.session.lock();
            let mine = guard.as_ref().is_some_and(|s| s.generation == generation);
            if mine {
                guard.take()
            } else {
                None
            }
        };
        Self::end(session);
    }

    fn end(session: Option<Session>) {
        let Some(session) = session else { return };
        session.audio_stop.store(true, Ordering::SeqCst);
        // Bind first so the lock guard is released before the child is killed.
        let child = session.child.lock().take();
        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

/// Misconfiguration cannot be retried away; connectivity failures can.
fn is_fatal(err: &anyhow::Error) -> bool {
    err.to_string().starts_with("FATAL:")
}

/// Forwards captured PCM to the sidecar's stdin, coalescing whatever has
/// already queued up so we write a few larger buffers instead of many tiny ones.
fn spawn_stdin_writer(
    child: Arc<Mutex<Option<CommandChild>>>,
    samples: StdReceiver<Vec<i16>>,
    stop: Arc<AtomicBool>,
) {
    std::thread::Builder::new()
        .name("pulpitry-audio-writer".into())
        .spawn(move || {
            const MAX_CHUNK: usize = 32 * 1024;
            while let Ok(chunk) = samples.recv() {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut bytes = Vec::with_capacity(chunk.len() * 2);
                extend_le(&mut bytes, &chunk);
                while bytes.len() < MAX_CHUNK {
                    match samples.try_recv() {
                        Ok(more) => extend_le(&mut bytes, &more),
                        Err(_) => break,
                    }
                }

                let mut guard = child.lock();
                let Some(process) = guard.as_mut() else { break };
                if let Err(err) = process.write(&bytes) {
                    eprintln!("[audio] could not write to the sidecar: {err}");
                    break;
                }
            }

            // Whatever ended the loop — a failed write, or the capture thread
            // dropping its sender because the microphone was lost — no more
            // audio can reach Azure. The sidecar would otherwise sit there
            // healthy and silent, so kill it: that surfaces as a termination
            // and the supervisor rebuilds the whole session, microphone
            // included. On a deliberate stop the child is already gone and
            // this is a no-op.
            let orphaned = child.lock().take();
            if let Some(orphaned) = orphaned {
                let _ = orphaned.kill();
            }
        })
        .ok();
}

fn extend_le(buffer: &mut Vec<u8>, samples: &[i16]) {
    for sample in samples {
        buffer.extend_from_slice(&sample.to_le_bytes());
    }
}
