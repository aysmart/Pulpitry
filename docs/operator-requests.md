# Six things an operator asked for

Sent by a church running Pulpitry, after real services. Each one below is what
they asked, what the code actually does today — checked, not remembered — and
what building it means.

Two of the six are already half-built, and knowing which half is missing
changes what they cost.

---

## 1. Suggestions while typing

> "This is referring to dropdowns and especially with long lists and even the
> scripture textboxes."

### Where it stands

- **The book picker** is a plain `<select>` of 66 books
  (`ChapterNavigator.tsx:358`). Reaching Zephaniah means scrolling a list the
  length of the Bible, and typing only jumps by first letter.
- **The scripture box** parses what is typed — "Jere 32 11", a range, words,
  or meaning — but offers nothing while it is being typed. An operator who
  half-remembers a book name gets no help until they submit.
- **The song and slide libraries** filter as you type, which is the behaviour
  the request is describing; they are the model, not the problem.
- **The translation pickers** are `<select>`s too, and a church with thirty
  translations installed has the same scrolling problem as the books.

### What to build

A small combo box — a text input with a list under it — used in three places:
the book picker, the scripture box, and the translation pickers. One component,
because three with slightly different keyboard behaviour is how a desk becomes
unlearnable.

- **In the book picker**, matches on any part of the name ("cor" finds both
  Corinthians) and on the numeral forms a person types ("1co", "1 cor").
- **In the scripture box**, suggestions are *references*, built from what has
  been typed: type "Jere" and the list offers Jeremiah with its chapter count,
  so the next keystroke is a number rather than the rest of the word. It never
  suggests a search phrase — suggesting words a preacher might be about to say
  would be guessing at scripture.
- **Keyboard first**: Down/Up move through the list, Enter takes the
  highlighted one, Escape closes the list and leaves the text alone.

### Decisions

- A suggestion list must never swallow Enter when nothing is highlighted —
  Enter still means *stage this reference*, which is the gesture the whole desk
  is built around.
- Books come from the translation being read, so a Catholic edition offers its
  own seventy-three.

**Effort:** the component and the book picker, half a day; the scripture box a
day, mostly on the keyboard rules.

---

## 2. More keyboard shortcuts

> "We need more keyboard shortcuts."

### Where it stands

There are eleven, and they are not discoverable anywhere in the window:

| Keys | What |
|---|---|
| ← / → | Previous and next |
| ↑ / ↓ | Wind a long reading a screenful |
| Enter, Enter | Stage, then put it up |
| Esc | Close an output that has covered your screen |
| ⌘/Ctrl + P | Projector |
| ⌘/Ctrl + Shift + P | Second display |
| ⌘/Ctrl + . | Clear the screen |
| ⌘/Ctrl + L | Start or stop listening |
| ⌘/Ctrl + H | Past services |
| ⌘/Ctrl + , | Settings |

All of them stand down while typing (`handsAreBusy` in `useTransport.ts`), which
is the rule any new one has to keep.

### What to build

1. **A shortcuts sheet**, `?` or ⌘/Ctrl + `/`, listing every key with what it
   does. Most of this request may be that the existing ones are invisible.
2. **The ones a service actually wants**, each earning its place:
   - `Space` — put what is staged on the screen. The commonest act in the hour.
   - `B` — blank the screen, and again to bring it back.
   - `1`–`9` — stage that slide of the deck, or that part of the song.
   - `⌘/Ctrl + F` — jump to the search box of the desk you are on.
   - `[` / `]` — previous and next desk.
   - `⌘/Ctrl + Enter` — stage *and* put up in one press, for the reference
     typed with a reading already announced.
3. **Chosen once, listed once**: a table in `lib/shortcuts.ts` that both the
   handler and the sheet read, so a key can never do one thing and be described
   as another.

### Decisions

- `Space` is one keystroke from a wall. It acts on what is *staged*, never on a
  selection, and does nothing when nothing is staged.
- Nothing gets a shortcut that cannot be undone by another: `B` toggles, Clear
  is already ⌘/Ctrl + `.`.

**Effort:** a day for the sheet and the table, a day for the keys.

---

## 3. Verse numbers when verses are combined

> "The verse numbers should also reflect in the display especially when
> multiple verses are displayed at a time."

### Where it stands

**The wall already does this** — `LiveBodyView.tsx:891` draws a superscript
number before each verse whenever more than one is shown. What does not:

| Surface | Today |
|---|---|
| The wall (projector, second display) | Numbered ✓ |
| Preview and Live panes on the desk | **No numbers** — `bodyText` joins the verses into one run of words |
| The stage display | **No numbers** — same path |
| A lower third or a shape | **No numbers** — `plainText` drops them |
| A paired Castavox | Lines cross with numbers, drawn there |

So the operator's own two panes disagree with the screen they are previewing,
which is probably what prompted this: they are reading the desk, not the hall.

### What to build

One function that renders a scripture body as text *with* its numbers, and the
three flattening paths use it: `bodyText` (the desk panes), the stage display,
and `plainText` (overlays and shapes).

- Numbers appear only when more than one verse is shown, exactly as the wall
  decides it, so the rule lives in one place.
- A lower third gets them too: a band carrying three verses is the case where a
  viewer most needs to know where one ends.

### And a switch for it

Numbering is a decision about how words are set, so it belongs where the rest
of that decision lives: **Display settings**, beside "Show the title under the
words", as a field on the look itself.

That gives it the same reach as the reference switch without any new
machinery: each desk keeps its own answer, and an output pointed at a template
of its own follows that template. A church that wants numbers on the wall and
none on the stream gets it by giving the stream its own look.

- **Shown when there is more than one verse**, and never for a single verse —
  the switch decides whether numbering happens at all, not whether it happens
  where it would read as noise.
- **On by default**, because that is what the wall does today, and a released
  behaviour should not change under a church that liked it.

### Decisions

- One field, `showVerseNumbers`, on the theme. The renderer already has the
  "more than one verse" rule; it gains one condition rather than a second rule
  to keep in step.

**Effort:** half a day for the four surfaces, plus an hour for the switch and
carrying it through the look editor.

---

## 4. Ctrl and the arrow keys to select more verses

> "Use arrows after pressing ctrl to select more scriptures verses."

### Where it stands

A passage is already selected with **shift-click** — click the first verse,
shift-click the last, and the range stages whole
(`ChapterNavigator.tsx`, `choose(verse, event.shiftKey)`). There is no keyboard
equivalent, and the arrow keys are taken: they step and wind.

### What to build

**Shift + ↑ / ↓** extends the staged passage by a verse in that direction, and
stages the new range as it goes. Shift rather than Ctrl, because it is the same
modifier that already extends by mouse, and because Ctrl/⌘ with arrows is the
operating system's on both platforms.

- It extends from the verse that was staged last, the way the shift-click
  anchor does.
- Collapsing back the other way removes a verse rather than jumping the anchor.
- It only acts when the chapter list holds what is staged; otherwise the keys
  keep their meaning.

### Decisions

- Worth confirming with the operator that Shift is acceptable. They asked for
  Ctrl, and Ctrl + ↑/↓ on macOS is Mission Control — a shortcut that fights the
  system is one that works on one machine and not the next.

**Effort:** half a day, once the modifier is settled.

---

## 5. Closing Pulpitry closes the displays

> "When you close pulpitry, close the displays too."

### Where it stands

Real, and worse than it sounds. The app stops the microphone and the sidecar on
exit (`lib.rs:2681`) but nothing closes the output windows. Because an output is
a window, the application also does not quit while one is open: closing the
operator window leaves a projector on the wall with no desk behind it, and no
way back to it except Force Quit.

### What to build

In the `ExitRequested` handler, beside the microphone: close every output
window, stop every NDI feed, and let the exit proceed. And treat the operator
window closing as the application closing, so the wall goes dark with the desk
rather than outliving it.

### Decisions

- An output must not be able to keep the app alive. A church that closes the
  desk has finished.
- Nothing is saved on the way out that is not saved already — the plan, the
  looks and the library all persist as they change.

**Effort:** an hour, plus a careful check on Windows, where window closing
order differs.

---

## 5b. An output with no screen appears on the laptop screen

> "When screen is on None — on the network only, when the display is opened, it
> renders the display on my laptop screen. This should not be."

A fault, and the one with the sharpest edge on this list: the output a church
sends to a switcher is the one that should never be seen in the room, and it is
landing on the only screen the operator has.

### Where it stands

The intent is in the code and reads correctly. An output with no screen is
parked past the left edge of the leftmost monitor — `PAST_THE_EDGE`,
`projector.rs:848` — so it is still drawn and still captured, but on no screen.
It is also built unfocused and kept out of the taskbar, precisely so nobody
meets it.

Two things are wrong in that neighbourhood, and only measurement will say which
one the operator is seeing:

1. **macOS rescues windows that are entirely off-screen.** When the display
   arrangement changes — a monitor unplugged, a projector waking, a resolution
   change, sometimes a sleep — macOS moves windows it considers off-screen back
   onto a valid screen. Parking alone is not a position a window can be relied
   on to keep.
2. **The window is built in the wrong units.** `monitor.position()` and
   `monitor.size()` are *physical* pixels; the builder's `.position()` and
   `.inner_size()` take *logical* ones. On a Retina Mac that is a factor of two
   — which also means every output given a screen is built twice the size of
   the monitor it is sent to. It overflows a borderless window covering
   everything, so nobody has noticed, but it is wrong and it is next door to
   this.

### What to build

1. **Measure first.** Log the position asked for and the window's own
   `outer_position()` immediately after building, and again a second later.
   That distinguishes "we put it in the wrong place" from "macOS moved it", and
   it is two lines that stay useful.
2. **Convert properly**, using the monitor's scale factor, so a window is asked
   for in the units the API is documented in — both branches.
3. **Park it, and keep it parked.** Watch the window's `Moved` event while it
   has no screen and put it back out: if macOS rescues it, it goes straight
   back, and a window that is rescued mid-service is off the wall in a frame
   rather than for the rest of the hour.

### Decisions

- Parked, not hidden. A hidden window is not captured, and this output exists
  to be captured.
- If macOS turns out to fight the park even with a Moved handler, the fallback
  is a window sized 1×1 at the corner with the real frame rendered off-screen —
  uglier, and only if measurement forces it.

**Effort:** an hour to measure, half a day for the units and the handler.

---

## 6. Compare Scripture

> "Also we need the Compare Scripture feature."

### Where it stands

Not built. Everything underneath it is: `scriptureIn(translation, reference)`
already fetches one passage in another translation — it is how an output reads a
different Bible from the desk.

### What to build

A **Compare** view in the scripture pane: the staged passage in two or more
translations at once, one column each, verse against verse.

- **Reading**, first: an operator checking a wording before it goes up, and a
  preacher who asks "what does the NASB say there".
- **Projecting**, second and deliberately separate: a column layout for the
  wall, two translations side by side with the reference once underneath. It
  reuses the designed-slide renderer rather than inventing a layout.
- Which translations are compared is a setting, defaulting to the desk's own
  plus the last one added.

### Decisions

- Three columns is the practical limit on a wall; the pane can show more.
- The comparison must be built from the library, never from a model — the same
  rule the rest of the app holds to.

**Effort:** two days for the pane, a further day to make it projectable.

---

## The order I would take them

1. **The screenless output on the operator's screen** (half a day, measure
   first). A feed meant for a switcher is covering the desk it is run from.
2. **Closing the displays** (an hour). The same family of fault: a projector
   outliving its desk.
3. **Verse numbers everywhere, with their switch** (half a day and an hour).
   Small, and it stops the operator's own panes from disagreeing with the wall.
4. **The shortcuts sheet, then the new keys** (two days). The sheet may answer
   most of the request on its own.
5. **Shift + arrows to extend a passage** (half a day) — ask about the modifier
   first.
6. **Suggestions while typing** (a day and a half), starting with the book
   picker, which is the one that hurts every service.
7. **Compare Scripture** (three days), last because it is the only one that is
   a new feature rather than a gap in one that exists.

Six and seven are what the operator will notice; one to five are what they will
stop having to work around. About eight days in all, and the first two days
are faults rather than features.
