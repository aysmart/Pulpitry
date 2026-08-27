# Slides worth projecting

A plan for `Make slides`. Three problems, two of them structural: the slides are
made from a fraction of the service, a slide can only contain text, and a slide
that contains more than text is still _drawn_ as text.

Read from `src-tauri/src/slides.rs`, `src/lib/catalog.ts`,
`src/lib/projector.ts`, `src/components/SlidesFromSermon.tsx` and
`src/lib/theme.ts` as they stood at 0.7.7. Phases one and two are now built;
what they taught is recorded against each section, and phase three is the
answer to a goal that only became clear once there were slides to look at.

## Where this stands

|                                                         |                                                        |
| ------------------------------------------------------- | ------------------------------------------------------ |
| **Phase one** — the whole service, anchored, reviewable | Built                                                  |
| **2.1 / 2.2** — a slide as components                   | Built: text, list, table, quote, passage, figure       |
| **2.3** — layouts                                       | Built: four arrangements, _derived_ rather than chosen |
| **2.4** — pictures                                      | Picked by hand. Matching and generation still ahead    |
| **2.5** — typography per layout                         | Built for the four arrangements                        |
| **Phase three** — slides built from shapes              | Not started, and the largest of the three              |

Four things below were written before the code existed and are wrong. They are
left in place with the correction beside them, because each one cost a day and
the reasoning that produced them is the reasoning that would produce them
again: **Backed**, **the component catalogue's eight**, **charts**, and **the
library-first ordering for pictures**.

## What is actually wrong

**Truncation.** `sermon.split_whitespace().take(4_000)` — the first 4,000 words
are sent and the rest is dropped without a word to the model or the operator. A
27,633-word service contributes its opening **14%**. For a service that begins
with welcome and notices, that is the least representative part of it.

**No anchor.** The prompt forbids invention plainly — _"do not add points they
did not make"_ — and nothing checks. A slide arrives as a title and three lines
with no trace of where it came from, so neither the code nor the operator can
tell a faithful slide from a plausible one.

**A slide can only be text.** A stored slide is
`{ kind: "slide"; blocks: TextBlock[] }`, and a `TextBlock` is
`{ text, level, align, bold, italic }`. There is no table, no picture, no
figure — and an image is not a thing a slide may contain but a _different kind
of thing to put on screen_, a sibling of a slide rather than part of one. Every
slide is therefore a centred heading over centred lines, and the only difference
between any two of them is the words.

**Not a bug.** The refusal to print scripture text is deliberate and should
stay. The model returns a reference; the application stages the real verse from
its own library. That rule is right, and it is the pattern the rest of this
plan follows.

The first two explain "made up". The third explains "not graphical". They want
fixing in that order, because a beautiful slide that misquotes the preacher is
worse than a plain one that doesn't.

## Phase one — slides that came from the service

Fidelity first. Nothing here is about how a slide looks.

### 1.1 Read the whole service

The machinery already exists and is shipping. `castavox_core::assistant::chunks`
splits a transcript into overlapping stretches, and `summarise.rs` already reads
a five-hour service that way. Slides should use it: an outline per stretch, then
one pass to order and dedupe.

Delete `MAX_WORDS` rather than raising it — a limit that silently drops the
second half of a sermon has no correct value.

### 1.2 Anchor everything that asserts a fact

The change that makes invention _detectable_ rather than merely forbidden. Each
component returns the stretch of transcript it came from, and the application
checks that it is really there:

```rust
pub struct Anchored<T> {
    pub value: T,
    /// The words in the transcript this was drawn from, quoted exactly.
    /// Checked; anything whose anchor is not in the transcript is dropped
    /// before anybody sees it.
    pub anchor: String,
}
```

Verification is a normalised substring search — fold whitespace and case, then
look for it. A model that invents a point cannot produce an anchor for it, so
the component disappears on its own. No prompt engineering required, and it
fails closed.

**The rule that decides what needs an anchor: does it assert something?** A
heading, a bullet, a quote, a table cell and every figure in a chart all claim
that something was said or is true, so each is anchored and dropped if it
cannot be. A background photograph asserts nothing, sets mood, and needs none.

That distinction matters more once tables and charts exist than it did for
text. A table of giving figures the preacher never gave is exactly the failure
this feature must not have, and it is far more convincing on a screen than a
wrong sentence.

> **Why this and not a firmer prompt.** The summary work spent a day on this
> exact question. "Do not invent" was already in the prompt and was already
> being obeyed most of the time; when the instruction was made _firmer_, the
> model wrote 2,657 words of confident fiction. Instructions are not a
> mechanism. A check is.

### 1.3 Show the anchor when reviewing

The operator is the last check, and cannot currently perform it. In the draft
list, each slide shows its anchor beneath it in small muted type — the
preacher's actual sentence under the slide it became. For a table or a chart,
the anchor for each row.

Approving a slide stops being an act of faith. It also makes a bad slide obvious
at a glance rather than at the projector.

## Phase two — what a slide can contain

Only once the words can be trusted.

### 2.1 A slide becomes a composition

The structural blocker, and everything else in this phase depends on it.
`projector.ts` already explains the shape this should take, one level up:

> _"A tagged union because the things a service puts on screen are genuinely
> different shapes: a passage is a numbered sequence, a song section is
> unnumbered lines that must break where they were written, an image has no
> text, and a clip has a timeline."_

The same reasoning applies inside a slide. A table is not a paragraph with tabs
in it and a chart is not a list of numbers; they are different shapes and want
different types.

```ts
type SlideComponent =
  | { kind: "text"; text: string; level: "title" | "statement" | "body" }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string; attribution: string }
  | { kind: "passage"; reference: string }          // app supplies the verse
  | { kind: "figure"; source: ImageSource; caption?: string }
  | { kind: "chart"; chart: ChartSpec }          // deferred to 3.4, narrower
  | { kind: "timeline"; events: { when: string; what: string }[] };  // withdrawn

| { kind: "slide";
    components: SlideComponent[];
    layout?: SlideLayout;
    background?: { source: ImageSource; dim: number };
    accent?: string;
    blocks?: TextBlock[];   // what every stored slide has today
  }
```

`blocks` stays and stays optional. A slide saved last Sunday keeps working and
renders exactly as it does now; the renderer reads `components` when they are
there and falls back to `blocks` when they are not. No migration, no flag day.

### 2.2 The component catalogue

Each one earns its place by being something a church service genuinely puts on
a screen, and by being a shape the others cannot express.

| Component    | What it is for                                                                             | Anchored              |
| ------------ | ------------------------------------------------------------------------------------------ | --------------------- |
| **Text**     | A title, a statement set large, or a line of body.                                         | Yes                   |
| **List**     | Two or three parallel points, ordered where the preacher numbered them.                    | Yes                   |
| **Table**    | A comparison the preacher drew — _under the law / under grace_ — a rota, a set of figures. | Every cell            |
| **Quote**    | The preacher's own sentence, or one they quoted, with attribution.                         | Yes                   |
| **Passage**  | A reference. The verse comes from the library, as now.                                     | Reference must appear |
| **Figure**   | A picture: from the library, or generated. Illustrative.                                   | No — asserts nothing  |
| **Chart**    | Giving, attendance, growth over time. Bar, line or share.                                  | Every figure          |
| **Timeline** | Ordered events: a chronology, a church's history, the steps of an argument.                | Every event           |

Eight is a deliberate ceiling, and the table's right-hand column is the point:
**six of the eight assert something and are checked; one does not.** A component
that cannot be checked and does assert something has no place in the list.

Tables and charts are the two worth being most careful with. A comparison table
is one of the most useful things a preacher's slide can carry — it is often the
literal shape of the argument — and a table of invented figures is the single
most damaging thing this feature could produce. Both follow from the same
change; only the checking separates them.

**Six of the eight are built:** text, list, table, quote, passage, figure. Chart
is deferred to 3.4 with a narrower brief than this table gives it. **Timeline is
withdrawn.** Nothing in a service asked for one in the whole of phases one and
two — a chronology is a table with a date column, and the steps of an argument
turned out to be a list drawn as steps, which is 3.1. It was a shape invented
for a catalogue rather than for a slide, and eight was a ceiling, not a target.

### 2.3 Layouts arrange components — built

Layout stops being decoration and becomes _how the components on this slide are
placed_.

| Layout      | Arrangement                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- |
| **Single**  | One component, set large. A statement that stands on its own.                               |
| **Stacked** | A heading ranged left under a hanging rule, and what sits beneath it. The common case.      |
| **Split**   | Two things side by side: a picture beside the words, or a comparison as two headed columns. |
| **Section** | A movement of the sermon begins. A heading and nothing under it, set enormous.              |

Four, not five, and **nobody chooses between them**. `layoutFor` derives the
arrangement from the components, because that is what "layouts arrange
components" means — and because a fifth thing for the model to get wrong on a
slide is a fifth thing to check. The layout had been hardcoded to `"stacked"`
at both save sites, so until this was written no slide had ever had another.

> **Backed was wrong, and the way it was wrong is the useful part.** _"A figure
> fills the frame; text sits in a corner over a scrim"_ is a good arrangement
> for stock scenery. A church's pictures are not stock scenery: they are the
> graphics the church already made, and they have words baked into them. Body
> text over "tracked in real time" is two headlines arguing, and no scrim dark
> enough to win that fight leaves a picture worth showing. A picture takes a
> panel and the words sit beside it, which is what Split already said.

Two smaller things the drawing taught, both of which read as design fussiness
and are not:

- **Section is not a broken slide.** A heading with nothing under it was drawn
  at body size in the middle of an empty frame and looked like a slide that had
  failed to load. It is the one slide meant to be read from the back.
- **A heading over columns ranges with them.** A table's columns start at the
  left edge because that is what makes them columns, so a centred heading above
  them has nothing to centre against.

### 2.4 Pictures: chosen first, then matched, then generated

Three sources, and the order has changed. **Chosen by hand** was not in this
plan and is now the only one built, for a reason nothing in the plan could have
known: _the library was empty_. 268 songs, four decks, three services — and no
pictures at all. Library matching built against that would have matched nothing
on every slide, and there would have been nothing to look at.

So the operator picks, from the church's pictures or from a file that joins them.
It is also the step that makes the other two testable: a slide that can hold a
picture and a frame that draws one well are what both remaining sources need,
and neither could be judged before they existed.

One more thing the empty library exposed: images are indexed on **title and
subtitle only**. Matching a mood works against "open sky over the hills" and
never against "IMG_4821", so the quality of the matching is the quality of the
naming — which is a thing to say in the app, not a thing to fix in the matcher.

Two sources still ahead, and the order matters.

```ts
type ImageSource =
  | { from: "library"; itemId: number; path: string } // built
  | { from: "generated"; prompt: string; assetId: string };
```

`path` beside the id, because a slide is drawn on a projector window that may be
another process and a synchronous render cannot go and ask the database where a
picture lives. The `generated` arm is deliberately not declared yet: a shape
with nothing behind it is the same fault as an arrangement nothing can trigger.

**From the library.** The model asks for a _mood_ — "open sky", "hands", "road
at dusk" — and the application matches it against images the church already
holds, exactly as it matches a reference against its own translations. This
should be tried first for every figure: it costs nothing, it is instant, and a
photograph the church chose fits the room better than one invented from a
phrase.

**Generated.** Where nothing in the library matches, the picture is generated
and **kept** — written into the media library as an ordinary item, so it is
generated once and belongs to the church afterwards. It can be reused, edited,
deleted and seen before Sunday like any other picture.

This is new infrastructure rather than a prompt change, and it is worth being
plain about the size of it:

- **The broker has no image route.** `api/v1/assist` is a chat completion and
  nothing else. Generating images needs a new endpoint, a provider that does it,
  its own metering against the subscription, and its own per-request cost — one
  that is several times a completion's.
- **Storage.** Generated pictures are files, not text. They need to land in the
  media library, be backed up with it, and count against whatever limits it has.
- **Rights.** Whatever the provider's terms say about generated images is what
  the church is relying on when one goes on a wall in front of a congregation.
  Worth reading once, recording the answer, and stating it in the app where an
  operator can see it.

**One rule on what may be generated: no text, no real people, no claims.** A
generated picture is scenery. A generated picture with words in it is a slide
nobody wrote and nothing checked, and it would walk straight past the anchoring
in phase one.

### 2.5 Typography per layout — built

What separates a presentation from a text dump, _within_ a slide made of lines.
Every slide was `heading, bold, centred` over `body, centred`: one relationship,
applied everywhere.

Each layout carries its own now. Section sets its heading enormous under a short
accent rule; Stacked ranges left under a hanging one with its body ranged to
match; Split gives each column its own heading in the accent over a hairline.

All of it in the container-relative units the frame already uses, so it holds at
any size.

> **The fit-to-frame claim was wrong.** "It inherits the existing fit-to-frame
> work, which means none of these layouts can overflow" — the fitting is wired
> to prose, not to composed slides, which are still sized from a guess at
> character count. A dense slide can push its last line past the frame; the gaps
> are tuned so a five-point slide holds. Fixing it properly means changing how
> every surface sizes text, and the three surfaces that draw a slide wrap it
> differently — a height that resolves on one does not on the others. That is
> the display-parity work, and it now has a concrete lead: `fitted` asks whether
> scrollHeight exceeds clientHeight, and on a box that hugs its contents those
> are the same number, so a one-sentence slide measured 29px against 30px and
> was set at the smallest size there is.

## Phase three — slides built from shapes

The goal arrived as a picture: a business-plan deck, nine slides, and not one of
them a heading over bullets. Lettered cards. A numbered step band. A four-box
quadrant. Filled fields of brand colour with a diagonal cut through them.
Photographs in shaped panels. Charts.

Set beside what phase two produces, the gap is not polish. **Every slide there
is built from shapes, and every slide of ours is built from lines of text.**
Three parallel points are three panels there and three bullets here. That is one
difference, repeated nine times, and it is the whole distance between "a slide
with the right words on it" and "a slide somebody designed".

Phase two was about what a slide _contains_. This is about what it is _made of_.

### 3.1 A list is not always bullets

The single highest-value change, because it needs no new component and no new
prompt: most sermon slides are two to four parallel points, and that is exactly
what a row of cards holds.

| Drawn as     | When                                                           |
| ------------ | -------------------------------------------------------------- |
| **Cards**    | Two to four parallel points. Each in its own panel.            |
| **Steps**    | The same, where the preacher numbered them: a band, connected. |
| **Quadrant** | Four points that pair off — two axes, not four items in a row. |
| **Bullets**  | Five or more, or points too long to sit in a panel.            |

One thing does have to change in what the model returns. Their cards carry **a
heading and a body**; our list items are single strings. A card of one sentence
is a bullet in a box, which is worse than a bullet.

```ts
| { kind: "list"; items: ListItem[]; ordered: boolean }

type ListItem = { text: string } | { heading: string; text: string };
```

Both shapes, because a heading is not always there to be had: "he was faithful,
he was patient, he was ready" has no headings in it and inventing three would be
inventing.

### 3.2 Colour as structure, not as accent

The piece that makes the largest visual difference and the one that reaches
furthest into existing code.

`ProjectorTheme` is a background and some text colours. It has no notion of a
_panel fill_, a _second_ brand colour, or a colour that goes behind a card. So
every structural device in 3.1 would be drawn in outline, and outlined cards on
a wall read as a form to fill in.

That means: new theme fields, the theme editor learning them, and the starter
templates carrying a real palette rather than a background and an accent. It is
the least glamorous item here and nothing above it looks right without it.

### 3.3 Geometry

The diagonal cut, the angled panel, the corner block. Cheap to draw — a clip
path and a filled div — and the thing that most makes a deck look authored
rather than assembled.

Worth doing **after** 3.1 and 3.2 and worth keeping small: geometry is where a
generated deck can most easily start looking like a template nobody chose. One
device per layout, taken from the brand, not a gallery.

### 3.4 Charts, and why fewer than the reference has

The reference has a donut of market share and a bar chart of revenue. In a
business template those are filler; on a sermon slide a chart needs figures the
preacher actually gave, and **a chart of figures nobody gave is the single most
damaging thing this feature could produce** — far more convincing than a wrong
sentence, and phase one exists precisely to stop that.

So: giving, attendance, growth over time — the handful of slides where a church
genuinely has numbers. Every figure anchored, the whole chart dropped if any
figure is not in the transcript. Not because charts are hard to draw, but
because this is the one component whose failure mode is a congregation believing
something untrue and no one in the room able to tell.

### What phase three does not add

- **A slide designer.** These are arrangements derived from content, as in 2.3.
  An operator under service pressure needs one decision, and "which of nine
  templates" is not it.
- **A second theme per deck.** The service's theme is the service's.
- **Anything that makes the model choose a shape.** Cards versus bullets is a
  function of how many points there are and whether they have headings — both
  facts already in the components, both checkable, neither an instruction.

## What I would still not build

- **Scripture text on a generated slide.** Already correctly refused. The
  library holds the translations, and the publisher correspondence is a live
  matter.
- **Text inside a generated image.** See 2.4. It defeats the checking that the
  whole of phase one exists to provide — and 2.3 found the same fault from the
  other end: a picture that already had words in it could not be used as a
  backdrop at all.
- **A theme picker per slide.** An operator under service pressure needs one
  decision, not thirty. The layout is the decision; the theme stays the
  service's.
- **Animation or transitions.** Different feature, different risk, and nothing
  about it is broken today.

## Order, and what it costs

**Phase one is a day** and touches `slides.rs`, the draft type and the review
list. It is worth shipping alone: slides drawn from the whole service and
checked against it are useful even while they still look as they do now.

**Phase 2.1 and 2.2 are the substance** — the union, the renderer that branches
on it, and the model being taught to produce components rather than lines. Text,
list and quote can land first and cost little; table, chart and timeline each
need their own renderer and their own checking.

**Phase 2.4 is a project of its own.** Choosing by hand is small and is done.
The matching half is small too, and pointless until a church has named pictures
to match against. The generated half is a broker endpoint, a provider contract,
metering, storage and a rights answer, and it should not be bundled into the
same release as the rest.

**Phase three is the largest of the three, and 3.2 is its floor.** Cards are the
value and colour is what makes them work; outlined cards on a wall read as a
form to fill in. So: 3.2 first even though it shows nothing on its own, then 3.1
for one arrangement, on a real screen, before the rest. 3.3 is a day. 3.4 should
be last and may never be worth it.

The risk worth naming, twice over. **2.2 was where this could have gone wrong
the way the summary work did** — and the thing that stopped it was not care, it
was that layout turned out to be _derivable_. Nothing asks the model which
arrangement to use, so there is no judgement of its to be bad. Phase three has to
hold that line: cards versus bullets is a function of how many points there are
and whether they have headings, and the moment it becomes a question put to the
model it becomes a question answered differently on two consecutive Sundays.

The second risk is the one the reference deck carries in. **It is a business
template, and its polish is partly the polish of having nothing to say.** Nine
slides of "Marketing strategy's goal is to allow an organisation to focus
resources on the greatest opportunities" look immaculate because no sentence in
them has to survive being true. A sermon slide carries a claim somebody made in
a room. Take the shapes; do not take the willingness to fill them.
