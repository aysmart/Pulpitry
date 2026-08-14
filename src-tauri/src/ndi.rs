//! Putting what is on the projector onto the network, as an NDI source.
//!
//! A church with a video team has a switcher or a streaming machine that is not
//! this one, and today the only way to get Pulpitry's output into it is an HDMI
//! cable into a capture card. NDI replaces that cable with the network the
//! building already has: Pulpitry announces itself, and anything that speaks NDI
//! -- OBS, vMix, a hardware switcher, Castavox -- can take the feed by name.
//!
//! # This is not how Pulpitry talks to Castavox
//!
//! It would be a mistake to read this as the mirror. The mirror sends *what is
//! staged* -- a reference, a few dozen bytes -- and Castavox draws it from its
//! own library at full resolution. That is the right way to put a verse on a
//! stream and it works on church wifi, which this does not: uncompressed 1080p
//! is around 100 Mbit/s, and `docs/competing.md` says plainly why we did not
//! build the main path that way.
//!
//! This is for the other case. A church whose video mixer is not Castavox, or
//! that wants the actual pixels -- a video playing, a background moving, a
//! layout we render and they cannot reproduce -- needs a picture, and a picture
//! is what this sends. It is a wired-gigabit feature and it should be described
//! as one.
//!
//! # The runtime is the church's, not ours
//!
//! The NDI runtime is Vizrt's, redistributable only under their terms, and it is
//! not in this application and never will be. It is loaded if it is there and
//! reported as missing if it is not -- the same arrangement every other NDI
//! integration in the industry has, including OBS's.
//!
//! So everything here is loaded at runtime from whatever the machine has, via
//! `libloading` -- one crate rather than a `dlopen` arm and a `LoadLibrary` arm,
//! because a church running Windows is the case this feature exists for and a
//! platform split is where that would quietly stop working. The flat exports
//! are used rather than `NDIlib_v5_load`, whose
//! return is a large struct of function pointers whose layout we would be
//! copying by hand and getting silently wrong on the first version that added a
//! field in the middle. A handful of named symbols cannot drift that way: a
//! symbol is either there or it is not, and if it is not we say so.
//!
//! # Why the structs below are safe to declare ourselves
//!
//! They are the NDI C ABI, written out in `#[repr(C)]` so the compiler inserts
//! the same padding a C compiler would. Two of them have a hole in the middle
//! -- `timecode` is 8-aligned and follows seven 4-byte fields -- and writing
//! them out by hand is exactly how that gets wrong, so there is a test below
//! that asserts the offsets rather than trusting the reading.

use std::ffi::{c_char, c_float, c_int, c_void, CString};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use libloading::{Library, Symbol};

/// `NDI_LIB_FOURCC('B','G','R','A')`, which is what a little-endian machine
/// hands us when it hands us RGBA in memory order.
const FOURCC_BGRA: c_int = 0x4152_4742;

/// `NDIlib_frame_format_type_progressive`. Nothing here is interlaced.
const FORMAT_PROGRESSIVE: c_int = 1;

#[repr(C)]
struct SendCreate {
    name: *const c_char,
    groups: *const c_char,
    /// Whether the library paces our sends to the frame rate.
    ///
    /// On. It is the difference between a receiver seeing a steady feed and a
    /// receiver seeing whatever rate our capture happened to manage, and it
    /// means the send loop can be a plain loop rather than a scheduler.
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
struct VideoFrame {
    xres: c_int,
    yres: c_int,
    four_cc: c_int,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: c_float,
    frame_format_type: c_int,
    timecode: i64,
    data: *const u8,
    line_stride_in_bytes: c_int,
    metadata: *const c_char,
    timestamp: i64,
}

#[repr(C)]
struct FindCreate {
    show_local_sources: bool,
    groups: *const c_char,
    extra_ips: *const c_char,
}

#[repr(C)]
struct Source {
    name: *const c_char,
    url: *const c_char,
}

type Instance = *mut c_void;

/// The library, opened.
///
/// Holds the handle as well as the symbols: dropping the handle unloads the
/// library, and a function pointer into an unloaded library is a crash rather
/// than an error.
pub struct Runtime {
    initialize: unsafe extern "C" fn() -> bool,
    supported_cpu: unsafe extern "C" fn() -> bool,
    send_create: unsafe extern "C" fn(*const SendCreate) -> Instance,
    send_destroy: unsafe extern "C" fn(Instance),
    send_video: unsafe extern "C" fn(Instance, *const VideoFrame),
    find_create: unsafe extern "C" fn(*const FindCreate) -> Instance,
    find_destroy: unsafe extern "C" fn(Instance),
    find_wait: unsafe extern "C" fn(Instance, u32) -> bool,
    find_sources: unsafe extern "C" fn(Instance, *mut u32) -> *const Source,
    /// Last, so it is dropped last.
    ///
    /// Rust drops fields in declaration order, and every pointer above points
    /// into this library. Unloading it first would leave the rest of this
    /// struct as function pointers into freed pages -- a crash rather than an
    /// error, in the closing seconds of a service.
    _library: Library,
}

// The library is thread-safe by its own documentation, and the pointers are
// only ever called, never written.
unsafe impl Send for Runtime {}
unsafe impl Sync for Runtime {}

/// Where the runtime is looked for, in order.
///
/// The environment variable first, because it is what NDI's own loader honours
/// and what lets a developer point at an extracted copy without an installer.
/// Then the place the official package puts it.
fn search_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    for key in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5"] {
        if let Ok(dir) = std::env::var(key) {
            if !dir.is_empty() {
                paths.push(Path::new(&dir).join(LIBRARY));
            }
        }
    }

    for dir in DEFAULT_DIRS {
        paths.push(Path::new(dir).join(LIBRARY));
    }

    // Last: whatever the loader's own search finds. A bare name is not a path,
    // so this is only reached if the library is already on the search path.
    paths.push(PathBuf::from(LIBRARY));
    paths
}

#[cfg(target_os = "macos")]
const LIBRARY: &str = "libndi.dylib";
#[cfg(target_os = "macos")]
const DEFAULT_DIRS: &[&str] = &["/usr/local/lib", "/opt/homebrew/lib"];

#[cfg(target_os = "windows")]
const LIBRARY: &str = "Processing.NDI.Lib.x64.dll";
#[cfg(target_os = "windows")]
const DEFAULT_DIRS: &[&str] = &[r"C:\Program Files\NDI\NDI 6 Runtime\v6"];

#[cfg(target_os = "linux")]
const LIBRARY: &str = "libndi.so.6";
#[cfg(target_os = "linux")]
const DEFAULT_DIRS: &[&str] = &["/usr/local/lib", "/usr/lib"];

/// What to tell a church that has not installed it. Named once so the settings
/// panel and the log cannot drift apart.
pub const MISSING: &str =
    "The NDI runtime is not installed on this machine. It is free, and it is \
     Vizrt's rather than ours to include — install NDI Tools from ndi.video and \
     reopen Pulpitry.";

impl Runtime {
    /// Opens the runtime, or says why it could not.
    ///
    /// Absence is not an error worth raising to the operator on its own: most
    /// churches will never install this and should never see a word about it.
    /// The caller decides whether anybody is asking.
    pub fn open() -> Option<Self> {
        for path in search_paths() {
            if let Some(runtime) = unsafe { Self::open_at(&path) } {
                crate::log_line!("[ndi] loaded {}", path.display());
                return Some(runtime);
            }
        }
        None
    }

    unsafe fn open_at(path: &Path) -> Option<Self> {
        let library = Library::new(path.as_os_str()).ok()?;

        /*
         * Each symbol, transmuted to a bare function pointer.
         *
         * `libloading::Symbol` borrows the library it came from, which cannot
         * be expressed alongside the library in one struct. Detaching them is
         * sound only because the library is a field of that same struct and is
         * declared last, so nothing here outlives what it points into.
         *
         * A missing symbol returns rather than being unwrapped: an NDI 4
         * runtime left behind by some other application has some of these and
         * not others, and half a binding is worse than none.
         */
        macro_rules! symbol {
            ($name:literal) => {{
                let found: Symbol<'_, _> = match library.get($name) {
                    Ok(symbol) => symbol,
                    Err(_) => {
                        crate::log_line!(
                            "[ndi] {} has no {}",
                            path.display(),
                            String::from_utf8_lossy($name).trim_end_matches('\0'),
                        );
                        return None;
                    }
                };
                *found
            }};
        }

        let runtime = Self {
            initialize: symbol!(b"NDIlib_initialize\0"),
            supported_cpu: symbol!(b"NDIlib_is_supported_CPU\0"),
            send_create: symbol!(b"NDIlib_send_create\0"),
            send_destroy: symbol!(b"NDIlib_send_destroy\0"),
            send_video: symbol!(b"NDIlib_send_send_video_v2\0"),
            find_create: symbol!(b"NDIlib_find_create_v2\0"),
            find_destroy: symbol!(b"NDIlib_find_destroy\0"),
            find_wait: symbol!(b"NDIlib_find_wait_for_sources\0"),
            find_sources: symbol!(b"NDIlib_find_get_current_sources\0"),
            _library: library,
        };

        // Both are the library's own opinion of whether it can run here, and
        // both have to be asked before anything else is called.
        if !(runtime.supported_cpu)() || !(runtime.initialize)() {
            crate::log_line!("[ndi] the runtime declined to start on this processor");
            return None;
        }

        Some(runtime)
    }

    /// Starts announcing a source under this name.
    pub fn sender(&self, name: &str) -> Option<Sender<'_>> {
        let name = CString::new(name).ok()?;
        let settings = SendCreate {
            name: name.as_ptr(),
            groups: std::ptr::null(),
            clock_video: true,
            clock_audio: false,
        };

        let instance = unsafe { (self.send_create)(&settings) };
        if instance.is_null() {
            return None;
        }
        Some(Sender { runtime: self, instance: Mutex::new(instance) })
    }

    /// Which sources this machine can see, for confirming we are on the network.
    ///
    /// Wanted by the settings panel -- "is anybody able to see this?" is the
    /// only question an operator has about NDI, and answering it from our own
    /// discovery is better than telling them to go and look in OBS.
    pub fn sources(&self, wait_ms: u32) -> Vec<String> {
        let settings = FindCreate {
            show_local_sources: true,
            groups: std::ptr::null(),
            extra_ips: std::ptr::null(),
        };

        unsafe {
            let finder = (self.find_create)(&settings);
            if finder.is_null() {
                return Vec::new();
            }

            (self.find_wait)(finder, wait_ms);

            let mut count: u32 = 0;
            let first = (self.find_sources)(finder, &mut count);

            let mut names = Vec::new();
            if !first.is_null() {
                for at in 0..count as isize {
                    let source = &*first.offset(at);
                    if !source.name.is_null() {
                        names.push(
                            std::ffi::CStr::from_ptr(source.name).to_string_lossy().into_owned(),
                        );
                    }
                }
            }

            (self.find_destroy)(finder);
            names
        }
    }
}

/// One announced source, and the frames going into it.
pub struct Sender<'a> {
    runtime: &'a Runtime,
    /// Behind a lock because sending is called from the capture thread while
    /// the operator may be closing it from the main one.
    instance: Mutex<Instance>,
}

unsafe impl Send for Sender<'_> {}
unsafe impl Sync for Sender<'_> {}

impl Sender<'_> {
    /// Sends one frame of 8-bit BGRA, top row first.
    ///
    /// BGRA rather than RGBA because it is what every compositor on both
    /// platforms hands back, and asking NDI to take the byte order the machine
    /// already produced avoids a per-pixel swap on the way out.
    ///
    /// Returns false when the buffer is not the size it claims to be, which is
    /// a bug here rather than something to report to a church -- but it must not
    /// be a read past the end of an allocation.
    pub fn send_bgra(&self, width: u32, height: u32, pixels: &[u8], fps: u32) -> bool {
        let expected = width as usize * height as usize * 4;
        if width == 0 || height == 0 || pixels.len() < expected {
            return false;
        }

        let frame = VideoFrame {
            xres: width as c_int,
            yres: height as c_int,
            four_cc: FOURCC_BGRA,
            frame_rate_n: fps.max(1) as c_int,
            frame_rate_d: 1,
            // Zero means "square pixels, work it out from the resolution",
            // which is right for everything we draw.
            picture_aspect_ratio: 0.0,
            frame_format_type: FORMAT_PROGRESSIVE,
            // Zero asks the library to timestamp it as it goes out. Ours would
            // be the time we captured, which is not the same thing and is worse.
            timecode: 0,
            data: pixels.as_ptr(),
            line_stride_in_bytes: (width * 4) as c_int,
            metadata: std::ptr::null(),
            timestamp: 0,
        };

        let instance = self.instance.lock().unwrap();
        // Synchronous: the call returns once the library has taken the pixels,
        // so `pixels` outliving this line is the whole of the safety argument.
        unsafe { (self.runtime.send_video)(*instance, &frame) };
        true
    }
}

impl Drop for Sender<'_> {
    fn drop(&mut self) {
        let instance = self.instance.lock().unwrap();
        unsafe { (self.runtime.send_destroy)(*instance) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    /// The two structs with a hole in them.
    ///
    /// `timecode` is 8-aligned and follows seven 4-byte fields, so the compiler
    /// puts four bytes of nothing in front of it -- and a hand-written binding
    /// that gets this wrong does not fail to compile. It sends a frame whose
    /// every field after the hole is read from the wrong place, which looks like
    /// a corrupt picture or a crash inside a library we have no source for.
    #[test]
    fn the_frame_matches_the_c_layout() {
        assert_eq!(offset_of!(VideoFrame, xres), 0);
        assert_eq!(offset_of!(VideoFrame, four_cc), 8);
        assert_eq!(offset_of!(VideoFrame, frame_format_type), 24);
        assert_eq!(offset_of!(VideoFrame, timecode), 32, "the padding before timecode");
        assert_eq!(offset_of!(VideoFrame, data), 40);
        assert_eq!(offset_of!(VideoFrame, line_stride_in_bytes), 48);
        assert_eq!(offset_of!(VideoFrame, metadata), 56, "the padding before metadata");
        assert_eq!(offset_of!(VideoFrame, timestamp), 64);
        assert_eq!(std::mem::size_of::<VideoFrame>(), 72);
    }

    #[test]
    fn the_create_settings_match_the_c_layout() {
        assert_eq!(offset_of!(SendCreate, name), 0);
        assert_eq!(offset_of!(SendCreate, groups), 8);
        assert_eq!(offset_of!(SendCreate, clock_video), 16);
        assert_eq!(offset_of!(SendCreate, clock_audio), 17);
        assert_eq!(offset_of!(Source, url), 8);
    }

    /// BGRA as NDI spells it, checked against the macro rather than the eye.
    #[test]
    fn the_fourcc_is_bgra() {
        let fourcc = (b'B' as i32) | ((b'G' as i32) << 8) | ((b'R' as i32) << 16)
            | ((b'A' as i32) << 24);
        assert_eq!(FOURCC_BGRA, fourcc);
    }

    /// A frame no larger than its buffer.
    ///
    /// The failure this stops is a read past the end of an allocation inside a
    /// closed-source library, which is the worst place for one.
    #[test]
    fn a_frame_shorter_than_it_claims_is_refused() {
        let Some(runtime) = Runtime::open() else {
            eprintln!("no NDI runtime here; skipping");
            return;
        };
        let sender = runtime.sender("Pulpitry test").expect("a sender");
        assert!(!sender.send_bgra(64, 64, &[0u8; 100], 30), "far too short");
        assert!(!sender.send_bgra(0, 0, &[], 30), "no picture at all");
        assert!(sender.send_bgra(4, 4, &[0u8; 64], 30), "exactly the right size");
    }

    /// End to end: a source we announce is a source this machine can find.
    ///
    /// Skipped where the runtime is not installed, which is most machines and
    /// every CI runner. It is the only test here that proves the binding works
    /// rather than that it is shaped correctly, so it is worth running by hand
    /// on a machine that has it.
    #[test]
    fn an_announced_source_can_be_discovered() {
        let Some(runtime) = Runtime::open() else {
            eprintln!("no NDI runtime here; skipping");
            return;
        };

        let name = format!("Pulpitry test {}", std::process::id());
        let sender = runtime.sender(&name).expect("a sender");

        // A receiver that has just started looking needs a frame or two before
        // it will admit it has seen anything.
        let pixels = vec![0u8; 320 * 180 * 4];
        for _ in 0..5 {
            assert!(sender.send_bgra(320, 180, &pixels, 30));
        }

        let found = runtime.sources(4000);
        assert!(
            found.iter().any(|source| source.contains(&name)),
            "announced {name} but discovery saw {found:?}",
        );
    }
}
