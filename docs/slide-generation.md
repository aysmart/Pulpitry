# Slides worth projecting

A plan for `Make slides`. Two problems, one of them structural: the slides are
made from a fraction of the service, and a slide can only contain text.

Read from `src-tauri/src/slides.rs`, `src/lib/catalog.ts`,
`src/lib/projector.ts`, `src/components/SlidesFromSermon.tsx` and
`src/lib/theme.ts` as they stand at 0.7.7.

## What is actually wrong

**Truncation.** `sermon.split_whitespace().take(4_000)` — the first 4,000 words
are sent and the rest is dropped without a word to the model or the operator. A
27,633-word service contributes its opening **14%**. For a service that begins
with welcome and notices, that is the least representative part of it.

**No anchor.** The prompt forbids invention plainly — *"do not add points they
did not make"* — and nothing checks. A slide arrives as a title and three lines
with no trace of where it came from, so neither the code nor the operator can
tell a faithful slide from a plausible one.

**A slide can only be text.** A stored slide is
`{ kind: "slide"; blocks: TextBlock[] }`, and a `TextBlock` is
`{ text, level, align, bold, italic }`. There is no table, no picture, no
figure — and an image is not a thing a slide may contain but a *different kind
of thing to put on screen*, a sibling of a slide rather than part of one. Every
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

The change that makes invention *detectable* rather than merely forbidden. Each
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
> being obeyed most of the time; when the instruction was made *firmer*, the
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

> *"A tagged union because the things a service puts on screen are genuinely
> different shapes: a passage is a numbered sequence, a song section is
> unnumbered lines that must break where they were written, an image has no
> text, and a clip has a timeline."*

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
  | { kind: "chart"; chart: ChartSpec }
  | { kind: "timeline"; events: { when: string; what: string }[] };

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

| Component | What it is for | Anchored |
| --- | --- | --- |
| **Text** | A title, a statement set large, or a line of body. | Yes |
| **List** | Two or three parallel points, ordered where the preacher numbered them. | Yes |
| **Table** | A comparison the preacher drew — *under the law / under grace* — a rota, a set of figures. | Every cell |
| **Quote** | The preacher's own sentence, or one they quoted, with attribution. | Yes |
| **Passage** | A reference. The verse comes from the library, as now. | Reference must appear |
| **Figure** | A picture: from the library, or generated. Illustrative. | No — asserts nothing |
| **Chart** | Giving, attendance, growth over time. Bar, line or share. | Every figure |
| **Timeline** | Ordered events: a chronology, a church's history, the steps of an argument. | Every event |

Eight is a deliberate ceiling, and the table's right-hand column is the point:
**six of the eight assert something and are checked; one does not.** A component
that cannot be checked and does assert something has no place in the list.

Tables and charts are the two worth being most careful with. A comparison table
is one of the most useful things a preacher's slide can carry — it is often the
literal shape of the argument — and a table of invented figures is the single
most damaging thing this feature could produce. Both follow from the same
change; only the checking separates them.

### 2.3 Layouts arrange components

Layout stops being decoration and becomes *how the components on this slide are
placed*.

| Layout | Arrangement |
| --- | --- |
| **Single** | One component, set large. A statement, a table, a chart. |
| **Stacked** | Title, then one component beneath. The common case. |
| **Split** | Two components side by side: text and a figure, or two tables. |
| **Backed** | A figure fills the frame; text sits in a corner over a scrim. |
| **Section** | A movement of the sermon begins. Title only, full-bleed, numbered. |

Five arrangements over eight components covers everything a service needs
without asking an operator under pressure to choose from a gallery.

### 2.4 Pictures: the library first, generated second

Two sources, and the order matters.

```ts
type ImageSource =
  | { from: "library"; itemId: number }
  | { from: "generated"; prompt: string; assetId: string };
```

**From the library.** The model asks for a *mood* — "open sky", "hands", "road
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

### 2.5 Typography per layout

What actually separates a presentation from a text dump. Today every slide is
`heading, bold, centred` over `body, centred`. That is one relationship, applied
everywhere.

Each layout carries its own: Section sets its number small and its title
enormous; Stacked ranges left with a hanging accent rule; Split gives the text
column a measure rather than centring it into the gutter; Backed pushes text to
a corner with a scrim behind it. Tables get a header weight, hairline rules and
`tabular-nums` so figures line up.

All of it in the container-relative units the frame already uses, so it holds at
any size — and it inherits the existing fit-to-frame work, which means none of
these layouts can overflow.

## What I would still not build

- **Scripture text on a generated slide.** Already correctly refused. The
  library holds the translations, and the publisher correspondence is a live
  matter.
- **Text inside a generated image.** See 2.4. It defeats the checking that the
  whole of phase one exists to provide.
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

**Phase 2.4 is a project of its own.** The library half is small. The generated
half is a broker endpoint, a provider contract, metering, storage and a rights
answer, and it should not be bundled into the same release as the rest.

The risk worth naming: **2.2 is where this could go wrong the way the summary
work did.** Eight components and five layouts is a judgement about what church
slides are, and if the model chooses among them badly the result will look worse
than the plain centred stack it replaced. Build one component and one layout end
to end, look at it on a real screen, and only then write the other seven.
