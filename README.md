# Pulpitry

Live speech transcription, Bible verse detection, and worship presentation for church
services. A native desktop app for macOS and Windows — a real `.app`/`.exe`, no browser
tab and no bundled Chromium.

## Where the project is

| Phase | Scope | State |
| --- | --- | --- |
| 1 | App shell, branding, icons, three-panel operator layout | Done |
| 2 | Azure Speech pipeline, live transcript, mic selector, settings | Done |
| 3 | KJV verse database + FTS5 + chapter navigator | Done |
| 4 | Exact verse detection | Done |
| 5 | Paraphrase/semantic matching | Done |
| 6 | Preview/Live panes, projector window, queue | Done |
| 7 | Song/lyrics library | Not started |
| 8 | Service schedule | Not started |

Phases 7 and 8 are the remaining work: a song library and a service running order.

## Architecture

```
Rust core (Tauri)
  ├─ cpal captures the selected microphone, downmixes to mono and
  │  resamples to 16 kHz/16-bit PCM
  ├─ supervises the sidecar process (spawn, crash recovery, backoff)
  ├─ holds settings; the Azure key lives in the OS credential store
  └─ re-emits transcript events on the Tauri event bus
          │  PCM on stdin        NDJSON on stdout
          ▼
Node sidecar (single fused executable, invisible to the user)
  └─ streams PCM to Azure Speech, emits interim and final results
```

### Why audio is captured in Rust, not in the sidecar

The brief left this open. It has to be Rust: the Azure Speech **JS** SDK implements
microphone input against `navigator.mediaDevices`, which does not exist in Node, so
`AudioConfig.fromDefaultMicrophoneInput()` cannot work in a sidecar process. The sidecar
therefore takes audio on stdin via `AudioConfig.fromStreamInput(pushStream)`.

This is the better arrangement anyway — cpal enumerates devices natively through
CoreAudio and WASAPI, which is what backs the mic selector, and cpal reports stable
device ids that survive reboots and replugging.

Downsampling averages each window of input samples rather than decimating, because plain
decimation folds high-frequency noise into the speech band and measurably hurts
recognition accuracy.

### The verse library

Ten public-domain translations ship with the app, about 311,000 verses in total:

| ID | Translation | Year |
| --- | --- | --- |
| KJV | King James Version | 1611 |
| ASV | American Standard Version | 1901 |
| BSB | Berean Standard Bible | 2023 |
| NHEB | New Heart English Bible | 2010 |
| BBE | Bible in Basic English | 1949 |
| YLT | Young's Literal Translation | 1898 |
| DARBY | Darby Translation | 1890 |
| WEBSTER | Webster's Bible | 1833 |
| GENEVA | Geneva Bible | 1599 |
| DRC | Douay-Rheims (Challoner) | 1752 |

**Copyrighted translations cannot be bundled.** NIV, ESV, NKJV, NLT, NASB, MSG, CSB and
LEB are all under licence and are deliberately absent — shipping them would be
redistribution. Adding one legally means obtaining a licence from the publisher.

`scripts/build-bible.mjs` fetches and normalises them into
`src-tauri/resources/<ID>.tsv.gz` (~1.3 MB each, 13 MB total) plus a
`translations.json` manifest. The generated files are committed, so builds need no
network access:

```sh
node scripts/build-bible.mjs             # all translations
node scripts/build-bible.mjs KJV ASV     # just these
```

Sources disagree about book naming — "I Samuel" vs "1 Samuel", "Revelation of John" vs
"Revelation" — so the build normalises every name to one canonical numbering. Without
that, switching translation mid-verse would not land on the same place. Books outside the
66-book canon (the deuterocanon in Douay-Rheims, for instance) are skipped and reported.

On first launch the translations import into SQLite at `<app data>/pulpitry.db` on a
background thread, one at a time in manifest order, each emitting a progress event. KJV
lands first, so the operator can work within a second or two while the rest arrive. The
finished database is roughly 100 MB.

#### Text quality gate

The build fails if a translation shows more than 25 places where a lowercase letter runs
straight into an uppercase one. That pattern almost always means the conversion lost a
separator, and it is invisible until someone reads it off a projector mid-service.

This caught a real defect: the upstream Darby text had lost the space before the divine
name in 3,681 places ("In the beginningGod created", "AndGod said") — about 10% of the
translation. `REPAIRS` in the build script carries a narrow, documented fix for it.

Repairs are held to a deliberately high bar: a repair must be provably mechanical, with a
single unambiguous reading, never an editorial judgement about wording. The Darby rule
qualifies because the following word is "God" or "Godhead" in every one of the 3,681
cases and no English word ends in "...God", so it cannot over-match. A few run-together
proper nouns survive in other translations (KJV's "EleloheIsrael") and are left alone.

Each manifest entry carries a checksum of its text. A corrected translation shipped in an
app update re-imports automatically — verse counts alone would miss it, since fixing
wording changes no counts.

The FTS5 index is external-content (it reads from the `verses` table rather than storing
a second copy) and is populated by a single `rebuild` after the import. Bulk-inserting
31,102 rows through per-row triggers is markedly slower for no benefit, since verse text
never changes after import.

An import that is interrupted partway is detected on the next launch and redone: a
translation counts as installed only when the row count actually matches the count
recorded for it.

The Chapter Navigator's single input does double duty. Text that parses as a reference
("Luke 3", "1 cor 13:4", "John3:16") navigates there; anything else falls back to
full-text search, so the operator never has to pick a mode mid-service. Ambiguous
abbreviations are deliberately *not* guessed — "jo" could be Job, Joel, John, Jonah or
Joshua, so it goes to search instead.

### The projector window

**Projector** in the header opens a second, frameless window on another display. With
more than one screen attached, a picker appears next to it; by default the projector goes
to the first display that is *not* the primary one, since during a service it is
essentially never the operator's own screen.

Parchment ground, ink text, the serif reserved for scripture, and nothing else — no logo,
no placeholder. Clearing leaves a blank screen, because that is the "off" state.

Verse length varies enormously: Esther 8:9 is 528 characters and John 11:35 is eleven.
Type size steps down in tiers by length so both fill the screen without overflowing it;
verified at 1920×1080 against both extremes.

#### Appearance

Settings → Projector display controls how scripture looks on the wall:

- **Typeface** from nine families, all present on both platforms without bundling anything
  further, plus the bundled Source Serif.
- **Size** as a multiplier on the automatic length-based sizing, so the tiers still hold.
- **Text and outline colour**, and **outline width**.
- **Soft drop shadow**, which lifts text off busy backgrounds where a hard outline reads
  as heavy.
- **Background**: a solid colour, an image, or a looping video.
- **Dim behind text**, a scrim over the background.
- **Show the reference** beneath, or not.

The outline uses `-webkit-text-stroke` with `paint-order: stroke fill`. Without the paint
order the stroke is centred on the glyph edge and eats into the letterforms, which at
projector size looks like a muddier, bolder typeface rather than an outline.

The **Live pane previews the real theme** — background, typeface, colour, outline and all
— so the operator can see what the congregation sees without turning round. Outline width
is divided down at panel scale, since a value authored for a 3-metre screen would swallow
the letters in a 300-pixel pane.

Background video is always muted: browsers refuse to autoplay with sound, and the hall has
its own.

#### Reading local files safely

Backgrounds are loaded through Tauri's asset protocol, which ships with an **empty scope**
— the webview can read no arbitrary file. Picking a background grants access to exactly
that one path, and a background chosen in a previous session is re-granted at startup.
This needs the `protocol-asset` feature on the `tauri` crate and `asset:` in the CSP's
`img-src` and `media-src`.

#### Why live state lives in Rust

Live content is owned by the Rust side rather than by either window. The projector can be
opened at any point during a service, and it has to come up showing whatever is already
live rather than staying blank until the operator next presses Display. Both windows read
the same state and react to the same `live:changed` event, so they cannot disagree about
what the congregation is seeing — the operator's Live pane is not a separate copy.

The window is borderless and sized to the monitor rather than truly fullscreen: macOS
fullscreen moves a window to its own Space, which takes it away from the operator and
animates on every change.

It is also always-on-top, which is a trap on a single-display machine — it would cover
the controls that close it. **Escape closes the projector** from the window itself, and
the header warns when only one screen was found.

### The queue

Stage a verse and press **Queue** to add it to the running order. The Queue tab lists what
is lined up; displaying an item takes it off the list, and each row can be removed
directly. History, alongside it, keeps what has already been shown.

### Exporting a transcript

**Export** in the Live Transcription panel header opens a native save dialog and writes
the session to a plain `.txt` file, defaulting to
`pulpitry-transcript-2026-08-02-1432.txt` so files sort chronologically.

```
Pulpitry transcript
Sunday, August 2, 2026
Language: en-NG · Microphone: MacBook Pro Microphone · 4 segments

[10:32] Good morning church, it is wonderful to see you all here.
[10:32] Turn with me to the gospel of John, chapter three.
[10:33] For God so loved the world, that he gave his only begotten Son.
```

One line per confirmed segment, timestamped to match what the operator saw. The short
header records when and how the session was captured, because a transcript filed away
months later is worth little without it.

Formatting lives in `src/lib/transcriptFile.ts`, deliberately free of any Tauri imports
so it can be exercised outside the app; `exportTranscript.ts` is the thin dialog-and-write
wrapper around it. The Rust side is a narrow `export_transcript` command rather than a
general file-writing one, and the path only ever comes from the native dialog.

Adding this raised the transcript retention ceiling from 400 lines to 5,000. Azure
confirms a segment every few seconds, so 400 covered barely half an hour — long enough
to look fine on screen while silently truncating the beginning of any export.

### Verse detection

Confirmed transcript segments are matched against the verse library to find scripture
being quoted verbatim. Paraphrase is phase 5's problem and is handled semantically; this
stage only claims a detection when the speaker's words and the verse's words line up in
the same order.

The design follows from one asymmetry: a missed detection costs the operator nothing —
the verse is a search away — while a false one puts the wrong reference in front of them
mid-service. Every threshold errs toward staying quiet.

#### Detection runs on speech in progress

Azure emits a *final* segment only after 800 ms of silence, and a preacher in full flow
may not pause for several seconds. Detection used to wait for those finals, so the
matching — which takes about 10 ms — was not the latency at all. The waiting was.

Detection now also runs on interim results, debounced to 250 ms. A verse surfaces while
the sentence is still being spoken: in the test case, John 3:16 is found after 16 of 23
words, seven words before the speaker finishes.

That makes the transcript buffer subtle. Azure re-sends the *same* utterance repeatedly as
it revises it, so appending each interim would stack one sentence over and over and match
phrases nobody said. The buffer therefore holds two parts — settled words that accumulate,
and a pending tail that interim results *replace*. A final clears the tail and appends its
corrected form. Seven tests pin that behaviour down, including a quotation spanning the
seam between settled and pending.

The model is deliberately **not** on this path. Interim text is revised several times a
second, so asking about it would spend requests on words the speaker did not finish
saying. It still sees only settled text.

How a detection is found:

1. A rolling 48-word buffer keeps recent speech, so a quotation split across two
   transcript segments is still seen as one run.
2. Seven-word probes slide across it with a stride of three, each an FTS5 phrase query.
3. A probe matching more than six verses is stock biblical language ("and it came to
   pass") and is dropped — whatever is being read, that phrase cannot say which.
4. For surviving candidates, the longest contiguous run of shared words is computed.
   Scattered shared words mean nothing; an unbroken run means the speaker is reading.
5. The run must be at least six words **and** carry at least three words that are not
   function words or narrative formula.
6. Confidence is the better of coverage (how much of the verse was quoted) and length —
   not a blend. A long verse quoted in part is real despite low coverage, and a short
   verse quoted whole is certain despite a short run.

Step 5 exists because of a false positive the tests caught: "and it came to pass when
they were in the" is ten consecutive words of verbatim scripture that matched three
different Genesis verses at once. Length alone is not evidence.

Detection runs on its own thread and holds the database lock while it works, so it can
never delay the transcript reaching the screen. Segments are dropped rather than queued
if it falls behind. A verse already reported is suppressed for 90 seconds, since the
rolling buffer would otherwise re-report it on every segment.

Detection searches whichever translation the operator has selected, which is why that
choice is persisted to settings rather than held in the window.

The thresholds are validated against the operator's real, fully imported library:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture
```

Those tests are ignored by default because they need the app to have been run once. A
small fixture cannot show what 311,000 verses do to the false positive rate, so that is
where the thresholds are really judged.

### Paraphrase matching

Exact detection only fires on verbatim quotation. A preacher who says *"God loved the
world so much he gave his one and only son"* is plainly pointing at John 3:16, and no
amount of string matching will see it.

Every verse in the working translation is embedded once with all-MiniLM-L6-v2 running
locally through candle, and kept in SQLite. Spoken phrases are embedded as they arrive
and compared by cosine similarity. This is entirely offline — no network, no cost — which
is the point: paraphrase matching has to keep working in a hall with no wifi.

`candle` was chosen over `ort` deliberately. ONNX Runtime could use a 23 MB quantised
model instead of 45 MB, but it needs a native library bundled, signed and notarised per
platform, and its quantised builds are architecture-specific. candle links statically and
behaves identically on both platforms, which is worth more than the 22 MB.

```sh
node scripts/build-embedder.mjs      # fetch and convert the weights
```

Weights ship as f16 rather than the upstream f32: nothing here needs that precision, it
halves 91 MB to 45 MB, and candle converts back on load so inference speed is unchanged.
The converted files are **not committed**; `npm run tauri:build` fetches them.

Building the index takes about two minutes per translation at ~237 verses/sec. It runs on
a background thread with progress reported to the status bar, and resumes where it
stopped if interrupted — a translation counts as indexed only when every verse has a
vector.

#### Storage

Vectors are stored as f32: 1,536 bytes per verse, so about **46 MB per indexed
translation**. Only translations the operator actually selects get indexed, but switching
between several adds up — two translations already puts the database past 200 MB.

Quantising to int8 would cut that fourfold at negligible cost to cosine accuracy, and is
the obvious optimisation if this becomes a problem. If the stored format ever does change,
the loader notices vectors it cannot read and rebuilds rather than silently matching
nothing — row counts alone would have reported such an index as complete.

#### Why the threshold is what it is

Raw cosine similarity does **not** cleanly separate paraphrase from ordinary speech, and
it is worth being honest about that. Measured against a 7,972-verse corpus:

| Spoken | Top match | Score |
| --- | --- | --- |
| "faith means being certain of the things we hope for" | Hebrews 11:1 | 0.81 |
| "everyone has sinned and nobody measures up to God's glory" | Romans 3:23 | 0.75 |
| "God loved the world so much that he gave his one and only son" | John 3:16 | 0.71 |
| "the Lord takes care of me like a shepherd" | Psalms 23:1 | 0.65 |
| *"the offering will be taken up during the next hymn"* | *(nothing relevant)* | *0.59* |
| "ask and it will be given to you, search and you will find" | Matthew 7:7 | 0.39 |

All six paraphrases retrieved the right verse at rank 1. But a service announcement about
the offering scores 0.59 against some verse or other — higher than a genuine paraphrase of
Matthew 7:7 at 0.39. No single threshold separates those two.

The margin between the top hit and its runners-up does not separate them either: the worst
paraphrase margin and the best noise margin are both 0.08.

So the default is **0.60**, chosen to sit just above the observed noise ceiling. That
surfaces 5 of 6 paraphrases with no false positives, and trades away the loose Matthew 7:7
match for silence. Operators who want more suggestions can lower it in Settings; the
`quality` test asserts this operating point and fails if noise ever reaches the default.

### Model-assisted suggestion (optional)

Exact detection only fires on verbatim quotation. A preacher who says *"God loved the
world so much he gave his only son"* is plainly pointing at John 3:16, and no amount of
string matching will see it. An optional Azure AI Foundry model covers that gap.

It is **off by default** and strictly additive — everything above keeps working with no
network at all.

#### The model never supplies scripture

This is the property the whole design protects. The model is asked for **references
only**, never verse text. Every reference it returns is resolved against the local
library, and the words the operator sees are read out of SQLite. A reference that does
not resolve is discarded and logged.

So the model can be wrong about *which* passage — and the operator reviews it, since
nothing reaches the projector without them pressing Display — but it cannot put invented
scripture on a screen. Tests cover the failure modes directly: a book that does not exist
("Hezekiah 4:12"), a verse past the end of a chapter ("John 3:999"), and a chapter-only
reference are all rejected.

Suggestions appear in the Paraphrase tab, labelled `quotation` or `allusion`, with the
model's own reason and its self-reported confidence. That confidence is *not* calibrated
and is only used to drop what the model was already unsure of.

#### The model restates, and the restatement is searched

One call returns two things: references it is confident about, and a **restatement** —
what the speaker is saying, rewritten in the vocabulary of scripture with pronouns
resolved and obvious mishearings corrected.

References go through local verification as before. The restatement is embedded and
searched against the index, which is where it earns its place. A preacher's own words sit
a long way from the verse in embedding space; the same idea phrased scripturally sits
close to it.

Measured against the real index:

| Spoken | As spoken | Restated |
| --- | --- | --- |
| "ask and it will be given to you, search and you will find" | 0.39 | **0.76** |
| "he takes care of me the way a shepherd looks after his sheep" | 0.65 | **1.00** |

The first case is exactly the one that used to fall below the 0.60 threshold and be
dropped. Restating recovers it.

An empty restatement is a valid, useful answer — it is the model saying the speaker is not
on scripture at all — and is never turned into a search.

#### Cost and latency

Requests are gated so a service costs pennies rather than pounds:

- Nothing is sent when exact detection already identified the passage — the model would
  add nothing and still be billed.
- At most one request every six seconds, however fast the speaker is going.
- At least 12 words of speech before a request is worth making.
- Only the last 60 words are sent, keeping each call small.

A 40-minute sermon works out at roughly 70 requests rather than one per segment. Replies
are capped at three references.

Failures degrade quietly: losing the network mid-service logs once, not once per segment,
and exact detection carries on regardless.

#### Configuration

Settings → Model assistance. Endpoint is the Foundry resource root, e.g.
`https://your-resource.services.ai.azure.com/models` — the `/chat/completions` path and
`api-version` query are appended, and a full path is accepted too. The key lives in the
OS credential store under its own entry, separate from the Speech key.

Replies are parsed tolerantly. Foundry hosts many model families with different habits
about prose and code fences, so the parser extracts the outermost JSON object rather than
trusting the reply to be clean, and treats junk as "no suggestions" rather than an error.

### Reconnection

Two layers, because there are two different failures:

- The **sidecar** rebuilds its recogniser when Azure cancels a session recoverably.
  Authentication and bad-request failures are marked `fatal` and are not retried.
- The **Rust supervisor** rebuilds the entire session — sidecar plus capture thread — if
  the process dies, backing off from 0.8 s to 15 s. A `fatal` message stops the loop so a
  wrong key does not retry forever.

## Prerequisites

- Rust (stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js 22+
- macOS: Xcode command line tools. Windows: MSVC build tools and WebView2.

## Running

```sh
npm install
npm run sidecar:build     # fuses the Node sidecar into a standalone executable
npm run tauri:dev
```

Open **Settings** and enter an Azure Speech key and region, then **Start listening**.

### Microphone permission in development

`tauri dev` runs an unbundled binary, so macOS attributes microphone access to the
*parent* process — your terminal or IDE. Grant that app microphone access under System
Settings → Privacy & Security → Microphone. Packaged builds prompt as Pulpitry itself,
using the description in `src-tauri/Info.plist`.

## Building a native package

```sh
npm run tauri:build
```

Produces a `.app` and `.dmg` on macOS, and `.msi`/NSIS installers on Windows. Signing
identities are not configured yet — builds are currently unsigned.

## Branding

`assets/pulpitry-mark.svg` is the source of truth for the logo. Regenerate the platform
icon sets after editing it:

```sh
npm run icons:build
```

Design tokens live in one place, `src/styles.css`, as a Tailwind `@theme` block:

| Token | Value | Use |
| --- | --- | --- |
| `--pulpitry-ink` | `#1C1B18` | operator UI chrome |
| `--pulpitry-gold` | `#E8B04B` | the single accent, reserved for anything live |
| `--pulpitry-teal` | `#3B6E64` | the verse detection system |
| `--pulpitry-parchment` | `#F4F1EA` | projector background, print/export |

UI chrome uses a sans stack at weights 400 and 500 only. Source Serif 4 is bundled
locally (no CDN, so it renders offline) and is reserved for scripture and lyric text in
the projector window.

## Layout of the repo

```
src/                 operator + projector React UI
src-tauri/           Rust core, Tauri config, icons, bundled sidecar binary
src-sidecar/         Node speech sidecar
scripts/             icon and sidecar build pipelines
assets/              logo source
```

## Notes and known constraints

- The fused sidecar is ~115 MB because Node's Single Executable Application support
  embeds the whole runtime. It compresses well in the installer but does inflate the
  bundle.
- The macOS deployment target is 11.0. Vite's bundler cannot emit for WebKit older than
  Safari 15, which Big Sur can run.
- The sidecar is built for the host architecture only. Cross-building for Intel Macs or
  for Windows requires running `npm run sidecar:build` on that platform.
