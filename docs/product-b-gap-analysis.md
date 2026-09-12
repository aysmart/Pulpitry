# Product B: what it does, where we stand, and the plan to get ahead

**Internal. None of this belongs on the website** — least of all the parts
where they are ahead.

Called Product B for the same reason Product A is: a competitor's name in our
own documents eventually leaks into a release note. Desktop app, Windows and
macOS, listens to a sermon and puts the verse on the screen. Same idea as
Pulpitry, same market, and it traded under another name until recently.

Pricing is deliberately left out of this version.

## Evidence

- Their site, how-it-works page, documentation and FAQ, read 2026-09-12.
- Six screenshots of the running app on a Mac, 2026-09-12: the Scriptures
  workspace, Slides, Lyrics, the theme picker, Settings → Help with the
  keyboard-shortcut list, and the slide editor.
- **Nobody has operated it.** Timings, detection quality under a Nigerian
  accent, and whether the keyable output really keys are still unverified.
  The last section lists what to try.

## What the app actually is

Three workspaces, switched at the top right: **Scriptures**, **Slides**,
**Lyrics**. One window at a time, each a full screen of panels.

### Scriptures

- **Live transcription** panel with its own Start button, and a quota readout
  in the title bar counting down the free hour.
- **Preview** and **Live** side by side, each drawing the verse card. Under
  Live: previous, **Clear**, **Hold**, next. Above: a **size slider** (1.0×)
  and an **Auto** toggle that lets detections go straight to the screen.
- **Scripture feed** on the right, with **History** and **Queue** tabs, each
  entry timestamped.
- **Chapter navigator**: the whole chapter listed, the live verse highlighted,
  a **Reference / Paraphrase** mode switch, a translation picker, a
  book-chapter-verse search box, a **Compare** toggle for two translations,
  and per-verse buttons to queue or cut.
- **Detected verses** panel with a **Sermon points** switch.
- **Paraphrase matches (AI)** as its own panel, with Live and Saved tabs.
- Audio input picked in the title bar; in the screenshot it is a virtual
  device, so they capture the machine's own output as happily as a microphone.

### Slides

- Decks as thumbnail strips, and a **Main output** column showing **Live
  display** and **Preview** with previous / clear / next.
- A library of **13 decks and templates**, searchable by title *and slide
  text*, filtered All / My decks / Templates.
- Templates are designed, not blank: Scripture Focus, Sermon Points, Welcome
  Service, Worship Night, Golden Welcome, Prayer Focus, Growth Track, Revival
  Service — gradient art, typeset.
- **A slide editor.** Add Text, Scripture, Shape or Image; a zoomable canvas;
  per-element font, weight, size, line height, letter spacing and colour;
  duplicate and delete pages. It is a small Canva, and it is theirs.

### Lyrics

- **Service schedule** built by adding songs, **Sections** panel per song,
  Preview and Live display with previous / display / next.
- **Song library** with Export and New — **empty on a fresh install**.
- **AI Magic Import**: online lyrics search, locked behind premium, with an
  import preview beside it.

### Theme picker ("Themify")

- **Output: Main or Alternate.** Two outputs, named, no more.
- **Background: Full screen or Lower third.** Two shapes.
- A gallery of backgrounds, several marked Motion, **most locked behind
  premium**; plus a transparent option and a **green-screen** option, which is
  how they expect a switcher to key them.
- **Import theme** for bringing your own.
- Scripture and lyrics have separate theme pickers.

### Settings, and the support surface

Transcription, Display, Bible Bank, Typography, Outputs, Usage, License,
Subscription, Help, Send Feedback. The Help pane is the part worth staring at:

- **YouTube tutorial** link.
- **What's new** → changelog, in the app.
- **Interactive highlights → Start tour**: a walkthrough of the app.
- **Send logs to support**, one button.
- **Contact us on WhatsApp**, with a copy button.
- Twitter, Instagram, TikTok, Facebook.
- **A documented keyboard-shortcut list**: arrows for next/previous verse,
  ⌘K search, ⇧T cycle translation, ⌘T themes, ⌘S settings, ⌘⇧R full refresh,
  ⌘⇧X clear session, M search mode, L live sync, ⌘D projection view, ⌘L lyrics
  mode, Enter to present.

## Where they are ahead

Ordered by what it costs us.

### 1. A phone as the operator's remote

Their documentation describes a mobile companion: change the display, switch
translation, move slides, manage the sermon from a phone. We have nothing. In a
room where the desk is at the back and the person who knows the service is at
the front, that is one volunteer instead of two. Not visible in the
screenshots, so its real scope is unverified — but it is on their site as a
headline.

### 2. The slide editor and the template gallery

Ours composes slides from structure — title, text, list, table — and lays them
out. Theirs lets a volunteer drag a text box, drop in a shape, set Poppins 700
at 30px with 4 of letter spacing, and save it as a page. Then it ships
thirteen designed decks so the first thing a church sees is something that
already looks made.

A church evaluating both on a Tuesday evening sees their gallery and our empty
list. This is the gap that decides the "does it look good?" question, and it is
the second biggest.

### 3. The translations churches ask for by name

They advertise 120–150+, including ESV, NIV, NKJV, NLT, NASB, CSB, AMP and MSG.
We ship 22: the public-domain and permissively licensed ones, plus Yoruba,
Igbo, Hausa, Swahili, Twi, French, Spanish and Portuguese.

Those named editions are licensed texts whose licences publishers rarely grant
to small companies, so how they carry them is their problem, not a capability
we can copy by deciding to. What we can stop doing is losing the comparison
in silence: say what we ship, say why, and put the African-language editions —
which they do not appear to offer at all — where a Nigerian church sees them
first.

### 4. Being easy to get help from

WhatsApp support, a tour, a YouTube channel, a changelog in the app, one-button
log upload, four social accounts. Individually small; together they are why a
church trusts a young product. Our Feedback pane asks three questions and
sends; there is no tour, no in-app changelog, no WhatsApp, no shortcut list.
In this market WhatsApp in particular is not a nice-to-have.

### 5. Songs from the tools churches already use

They import from EasyWorship and OpenLP, and offer an AI lyrics search for
everything else. Their library still starts empty, where ours ships 266
public-domain hymns — but a church with four hundred songs in EasyWorship
cares about the importer, not the hymnal.

### 6. Small operator affordances we should simply take

- **A live size slider.** Text bigger, now, without opening a theme.
- **Hold**, as a first-class button beside Clear.
- **Auto**, stated plainly as a switch: detections go live unattended.
- **Search that looks inside slide text**, not only titles.
- **A documented shortcut list in the app.**
- **A detection log** they export as CSV or JSON. We export summaries as text,
  .docx and PDF and keep transcripts, but not "what did we show, and when".

## Where we are ahead

Their two screenshots of output configuration are the whole of it: Main and
Alternate, full screen or lower third. Against that:

- **Outputs as a list.** Any number of congregation-facing screens, each with
  its own look, Bible, shape, capitals, resolution, and either a monitor or the
  network alone. Every feed is NDI, not one.
- **Six overlay shapes**, keyed by transparency rather than a green screen —
  which no switcher operator prefers, because green spills.
- **A stage display**: timer up or down, the time, what the congregation sees,
  what comes next in the plan, and a line the desk sends the platform. Nothing
  in their app suggests an equivalent.
- **Following the sermon through a deck** — offering the slide the preaching
  has reached — and slide commands by voice. Their sermon points are detection,
  not navigation.
- **Original languages**: the Greek and Hebrew behind the verse, with a lexicon.
- **Service summaries afterwards**, and transcript history.
- **Castavox**, a whole streaming application that draws the verse itself, and
  the mirror that pairs the two so one machine listens for both.
- **Themes that are all free** and designed by the church, against a gallery
  where most backgrounds are locked.
- **Local transcription on every platform.** This is the big one, below.

## The wedge: free, unlimited, local, and on Windows

Their free tier counts down an hour in the title bar. Their local engine is
**Apple-silicon only**; Windows and Intel Macs must use their cloud, which
means a Windows church at the desk — most Nigerian desks — is on a meter from
the first Sunday, and dead when the building's internet is.

Ours: transcription on the church's own machine, unlimited, offline, free for
ever, no account, on Windows and Mac and Linux. A subscription buys streaming
accuracy and the assistant; it does not buy the ability to work.

We have been describing this as "no free plan". It is the strongest thing we
have and it is currently told worse than their countdown. The exact words
matter: **"Free for ever, unlimited, on your own machine, with the internet
off."** That belongs on the pricing page, the download page, the product pages
and the first run.

Honesty attached: it needs a fast machine, and Time it measures theirs in
seconds. Say that in the same breath — it is what stops the promise turning
into a support thread.

## The plan

Ordered by what it wins us. Two things are settled and get no work at all:
**outputs**, where we are already further ahead than they are, and
**translations** — we ship the ones churches actually read, and chasing a
number nobody can license is not a plan.

### 1. Songs: a library worth switching for

The priority. Their library starts empty and their online search is locked
behind premium; ours ships 266 English public-domain hymns and nothing in any
Nigerian language. A church opening either app for the first time should find
its own songs already there — and only one of us can make that true.

**Track A — public domain, embedded.** Expand what we ship outright:

- English: from the 266 we carry to the thousands that are genuinely public
  domain (Hymnary, the Cyber Hymnal, Wikisource), with author, year and source
  on every record.
- **Local-language hymnals**, which is the part nobody else is doing:
  *Ìwé Orin Mímọ́*, the Yoruba Anglican hymnal, is about 600 hymns and exists
  as Bodleian/Google Books scans; there are Igbo, Hausa, Twi and Swahili
  equivalents from the same mission era. Those translations are old enough to
  be out of copyright, which is exactly why they are the right place to start.
  Where only scans exist, that is an OCR and proofreading job — the text is
  Yoruba with diacritics, so it needs a person to check it, not just a model.
- Traditional choruses, credited as traditional where no author is known.

**Track B — the contemporary catalogue.** The aim is that a church opens
Pulpitry and finds the songs it actually sings — including Nigerian gospel.
There are three routes to that and they are not equivalent:

- **Licensed at source.** Lyric catalogues are licensed to software by
  **LyricFind** and **Musixmatch**, and **CCLI** can be asked directly even
  though its partner programme is closed to new partners. This is the only
  route that lets the catalogue be a feature of the product — shipped or
  fetched, credited, and defensible. It is a commercial conversation rather
  than an engineering one, and it is the one worth starting this week, because
  everything else about songs is ready before it lands.
- **The church brings its own** — Track C. Immediate, legitimate, and it covers
  every church that already runs EasyWorship or OpenLP.
- **Scraped from lyrics sites and shipped by us.** Not a route. The words
  belong to publishers, the sites license them from LyricFind or Musixmatch and
  forbid harvesting in their terms, so this is our infringement distributed to
  churches who would reasonably assume the licence they hold covers what we
  gave them. Church media people know CCLI's rules better than most customers
  know any rule; one publisher notice would cost more trust in this market than
  the catalogue buys.

Whichever route lands, two conditions hold, because they cost nothing:

- **A versioned pack the app fetches**, not files inside the installer, so a
  correction or a withdrawal takes a day rather than a release.
- **Every record carries its credits** — title, author(s), copyright line, CCLI
  song number where known — and the lyric output *renders* them.

**Track C — the church's own songs.** Importers for **EasyWorship, OpenLP,
OpenSong and ProPresenter**, plus paste-and-parse: paste a song, get verses,
chorus and bridge split and labelled. A church with four hundred songs in
EasyWorship can be running on Sunday without retyping anything, and what it
imports is its own.

**And the library itself**: search that reads the lyrics and not just the
title, sections ordered the way the worship leader will actually call them, and
language tagging, so a Yoruba service is offered Yoruba first.

### 2. Themes, and motion in particular

Their gallery has motion backgrounds and most of them are locked. Ours should
be better and free, and there is a way to do that which needs no stock footage
and no licence at all: **render the motion ourselves**.

- **Procedural motion backgrounds** drawn in the output window — drifting
  gradients, bokeh, particles, light rays, ink in water, a slow starfield.
  Canvas or WebGL, a few hundred lines each, resolution-independent, so they
  are sharp at 4K and cost no download and no video decoder. A church can
  recolour them to its own palette, which a video loop can never do.
- **A gallery, not only a designer.** Twenty designed presets with thumbnails,
  so the first thing a church sees looks made. Our designer stays for the
  church that wants its own.
- **Theme files**: export and import one, so a church can carry its look
  between machines and we can publish new looks between releases.
- **Typography that goes further**: weight, line height and letter spacing per
  role, and a safe-area guide for the overlay shapes.
- **Lyrics get their own theme**, as scripture does.

### 3. Workspaces

They split the app into Scriptures, Slides and Lyrics, and it reads clearly
because each screen shows only what that job needs. Ours puts everything on
one desk, which is better in a hurry and worse to learn.

So: **workspace presets in one window** — Scripture, Songs, Slides, Plan —
switched at the top right, each arranging the panels that job needs, with the
preview/live pair and the transcript constant. One window is our advantage;
showing every panel at once is not.

### 4. Slides that look made before anybody edits them

- **A dozen designed decks** shipped with the app — welcome, announcements,
  sermon points, offering, prayer focus, scripture focus — in our themes. This
  is design work, not engineering, and it is the cheaper half.
- **An element editor** for a page: text, scripture, shape, image, with font,
  size, spacing and colour per element. The composed-slide model already
  exists; this is a canvas and a properties panel over it.

### 5. The fortnight's cheap wins

1. **Tell the free engine properly** — pricing page, download page, both
   product pages, first run: *free for ever, unlimited, on your own machine,
   with the internet off*, with the hardware caveat in the same breath.
2. **The support surface**: WhatsApp, a changelog rendered from the release
   notes we already write, the keyboard shortcuts we already have written down
   in the app, one-button log upload.
3. **Operator affordances**: a live size slider, Hold beside Clear, Auto as a
   plainly stated switch, search that reads slide text.
4. **A detection log export**, CSV — what we showed, and when.

### 6. Backlog, deliberately

- **The phone remote.** Filed as an issue; it is the largest single piece of
  work here and it needs the app to serve something on the church's network.
  Worth doing on our terms — paired like the mirror, never through anybody's
  cloud — rather than rushed.
- Two Bibles on one screen.
- A local REST/WebSocket API.

### Not on the list

- Chasing a translation count.
- Matching their accuracy and latency claims with claims of our own. Measure
  ours, publish what we measure.
- A premium-locked theme gallery. Ours being free is a difference worth
  keeping.

## To verify by driving it

1. **Is the transparent background actually keyable** in OBS — alpha, not a
   black or green fill? Their green-screen option suggests the transparent one
   may be newer or weaker.
2. **What is in Settings → Outputs?** Two outputs is what the theme picker
   implies; confirm whether Main and Alternate can differ in translation,
   shape and resolution, or only in background.
3. **Detection, timed**: stopwatch from spoken reference to verse on screen,
   three times; then a paraphrase; then a Nigerian accent; then "the next
   verse".
4. **Correcting a wrong verse mid-sermon**: how many clicks.
5. **The phone remote**: what it drives, and whether it needs their cloud.
6. **With the internet off** on Windows: what still works.
7. **Does anything resemble a stage display** or a service plan with timings?
8. **What the free hour actually gates** — transcription only, or features too.
