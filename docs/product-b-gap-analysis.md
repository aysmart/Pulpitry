# Product B, and where Pulpitry stands against it

**Internal. None of this belongs on the website** — least of all the parts
where they are ahead.

Called Product B here for the same reason Product A is: naming a competitor in
our own documents is a habit that eventually leaks into a release note. It is a
desktop app, Windows and macOS, that listens to a sermon and puts the verse on
the screen. Same idea as Pulpitry, same market — it prices in naira — and it
was called something else until recently, so there is a rebrand behind it.

## How this was compiled, and what is not in it

From their own public material: the product site, its how-it-works page, its
documentation, its FAQ and its pricing page, read 2026-09-12. **Nobody has
operated it.** So everything below is what they *say* they do, and the things
that decide whether a church stays — how good the detection really is, what
the operator's screen is like under pressure, whether the overlay output is
actually keyable — are unverified. There is a list at the end of what to try
when somebody has it in front of them.

## What they have that we do not

Ordered by how much I think it costs us.

### 1. A phone as the operator's remote

They ship a mobile companion: change the display, switch translation, move
slides, manage the sermon, from a phone, so the volunteer is not tied to the
laptop. We have nothing like it. In a room where the desk is at the back and
the person who knows the service is at the front, this is the difference
between one volunteer and two.

This is the gap I would close first. It is also the largest piece of work here,
because it needs the app to answer something over the network that is not
Castavox.

### 2. The translations churches ask for by name

They advertise 120–150+ translations including ESV, NIV, NKJV, NLT, NASB, CSB,
AMP and MSG. We ship 22, and they are the public-domain and permissively
licensed ones: KJV, WEB, the Free Bible Version, Yoruba, Igbo, Hausa, Swahili,
Twi, French, Spanish, Portuguese and so on.

A church that reads NIV from the pulpit compares those two lists and stops
reading ours. Worth being clear internally about what the difference actually
is: those editions are licensed texts, and the licences are held by
publishers who mostly do not grant them to small software companies. Whatever
they are doing to offer them is a question for them, not a capability we can
copy by deciding to.

What we can do is stop losing the comparison on the spot: say what we ship and
why, and make the African-language editions — which they do not appear to
offer at all — the thing a Nigerian church notices first.

### 3. Songs out of the tools churches already use

They import song libraries from EasyWorship and OpenLP. That is a migration
path: a church with four hundred songs in EasyWorship can try them on Sunday
without retyping anything. Our hymn library is 266 public-domain hymns and
whatever the church types in. An importer for those two formats is a
weekend's work and removes the single biggest reason not to switch.

### 4. A free tier that exists

Theirs: one hour of transcription, one device, no watermark. Ours: no free
plan at all — but transcription on the church's own machine is free for ever
and needs no account, which is a *better* offer badly told. Their free hour
runs out on the first Sunday; our free engine does not. That story is not on
our pricing page in those words.

### 5. Price, in this market

| | Product B | Castavox/Pulpitry |
|---|---|---|
| Free | ₦0 — 1 hour, 1 device | none named; local engine free, unmetered |
| Entry | ₦9,999 — 12 hours, 1 device | Desk $20 ≈ ₦31,000 — 3 devices, 45 h fair use |
| Unlimited | ₦15,000 — "unlimited", fair use, 1 device | — |
| Top | ₦37,000 — 3 devices | Studio $50 ≈ ₦77,500 — 8 devices, 120 h fair use |

At ₦1,550 to the dollar, their unlimited tier is about half our entry plan, and
their top tier is under half. We carry things they do not — Castavox, two
concurrent services, eight machines — but a church comparing the first line of
each page sees ₦15,000 against ₦31,000.

### 6. Smaller things, each real

- **Two translations side by side** on one screen. We can put different
  Bibles on different outputs, which is a different (and I think better)
  answer for two rooms, but not the one a church asks for when it wants
  English beside Yoruba on the same wall.
- **Custom CSS themes.** Our theme designer is better for the volunteer and
  worse for the one technical church that wants exactly its brand.
- **A local REST API and WebSocket** for custom integrations.
- **A detection log exported as CSV or JSON**, timestamped. We export
  summaries as text, .docx and PDF, and keep transcripts, but not that.
- **Claims we do not make:** 98% accuracy, 0.5-second latency. Ours is honest
  about arriving a second or two after a sentence on the local engine. Their
  number is a cloud number, which is why the next section matters.

## What we have that they do not

From their documentation, they have NDI output, a secondary display,
configurable themes and a session log. They do not describe:

- **Outputs as a list.** Any number of congregation-facing screens, each with
  its own look, Bible, shape, capitals, resolution, and either a monitor or
  the network alone. They describe one secondary display and one NDI feed.
- **Keyable overlays in six shapes**, sent with transparency intact, so a
  switcher lays the band over the camera instead of receiving a picture of a
  projector.
- **A stage display**: timer counting up or down, the time, what the
  congregation is seeing, what comes next in the plan, and a line the desk can
  send the platform.
- **Following the sermon through a deck** — offering the slide the preaching
  has reached — and slide commands by voice.
- **Service plans, media, backgrounds** with fit, scale and blur, a ticker.
- **Original languages**: the Greek and Hebrew behind the verse, with a
  lexicon. Nothing in their material suggests this exists.
- **Summaries of the service afterwards**, and the transcript history.
- **Castavox** — a whole streaming application that draws the verse itself —
  and the mirror that pairs the two so one machine listens for both.
- **Local transcription on every platform.** Theirs is Apple-silicon only;
  Windows and Intel Macs must use their cloud. A Windows church with no
  internet cannot run their product at all, and most Nigerian churches at the
  desk are on Windows.

That last point is the strongest thing we have and it is worth saying plainly
on the site: ours works with the building's internet down.

## What I would do, in order

1. **The phone remote.** Biggest operational win, and the one thing they have
   that a volunteer feels every single service.
2. **EasyWorship and OpenLP import.** Cheap, and it removes the cost of
   switching.
3. **Say the free engine louder** on the pricing page, in their terms: not
   "free plan" but "transcription on your own machine, free for ever, no
   account, offline".
4. **Two Bibles on one screen.** A shape, not an architecture: the outputs
   already carry a translation each.
5. **The African-language editions as a headline**, not an item in a list of
   22.
6. **A detection log export**, CSV. Small, and it answers "what did we show
   last Sunday" for a pastor who asks.
7. **REST/WebSocket**, last. One technical church in fifty asks, and NDI plus
   the mirror covers most of what they would build with it.

Not on the list: chasing 150 translations, or their accuracy and latency
numbers. The first we cannot license, and the second we should measure rather
than advertise.

## To verify by driving it

Their documentation cannot answer these, and each one changes the analysis:

1. **Is the NDI output keyable** — a lower third on transparency — or a
   picture of the whole screen? Take it into OBS and look for alpha.
2. **How many outputs can it drive at once**, and can two screens show
   different translations?
3. **What is the detection actually like** on a paraphrase, on a Nigerian
   accent, and on a preacher who says "the next verse"? Time from spoken
   reference to verse on screen, by stopwatch, three times.
4. **What does the operator do when it is wrong?** How many clicks to correct
   or clear a wrong verse mid-sermon.
5. **The phone remote**: what it can actually do, and whether it needs their
   cloud or works on church wifi.
6. **Songs**: does the import keep verse order and chords? What does the lyric
   screen look like?
7. **With the internet off** on a Windows machine: what still works?
8. **Where does the audio come from** — a microphone, or the machine's own
   output? Ours takes a device; if theirs can take system audio, that is a
   setup step fewer.
