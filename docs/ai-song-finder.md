# The AI Song Finder

Describe a song — a line half-remembered, what the chorus is about — and get the
song: the words, who wrote them, and what is known about the rights, from a
catalogue that comes with a Castavox subscription. Previewed before anything is
added, and copied into the church's own library one song at a time.

## Where the AI is, and where it is not

**In the finding.** Search is by meaning rather than by keyword — the query is
embedded and matched against the catalogue — because of how people actually ask
for songs: by a line, by what the song is about, by the way the chorus goes. A
keyword search answers none of those, and an operator at 9:40 on a Sunday has a
fragment, not a title. It is the same retrieval Pulpitry already does against
scripture, where a paraphrase finds the verse, pointed at a different corpus.

**Not in the words.** Nothing in the catalogue is generated. Every song is a
real entry assembled from libraries churches already own, carrying its own
rights, and one whose terms nobody has checked says so. An invented lyric on a
wall is the failure this product cannot have: a congregation singing a line the
songwriter never wrote, in a service, with our name on the screen. The model
chooses *which song*, never *what it says* — and that distinction is the claim
worth making rather than the one worth hiding.

## Why it is the one thing behind a subscription

Everything else in Pulpitry runs on the machine and is unlimited: the local
engine, the verse library, the slide studio, imports from EasyWorship,
ProPresenter, OpenLP and OpenSong, and anything the church writes themselves.
That is the position and it should stay the position.

The AI Song Finder is not on the machine. It is a catalogue somebody assembles,
checks, corrects and hosts, and the cost of keeping it is ongoing. So it sits
with the subscription, and the gate is the broker's — the endpoint refuses a
machine that is not activated. The pane's own gate is only the courtesy of
saying so before a request is made.

It answers the worst hour a church has with new software: the library is empty,
the service is at ten, and typing four songs out by hand at nine is how
presentation software gets abandoned. Every other way in assumes they are
already running something.

## Where the corpus comes from

Assembled from libraries a church already owns and exports — an EasyWorship
database, a ProPresenter export — normalised into the same `SongSection` and
`SongRights` shapes the catalogue stores, and served from the broker.

Pulpitry already reads three of those formats (`src-tauri/src/songs_import.rs`:
OpenSong, OpenLyrics, OpenLP, EasyWorship, pasted text). ProPresenter is the
gap, and it is the format most likely to arrive.

**Not scraped.** A lyrics site's terms forbid it, the words belong to
publishers rather than to the site, and a catalogue assembled that way would be
one takedown from disappearing out of churches' libraries. This is worth being
plain about internally as well as externally: the mechanism here is a hosted
catalogue with provenance per song, not a crawler.

## The rights position, which does not move

CCLI is a licence a church buys and reports against, not a service an
application can call. Pulpitry does not integrate it and does not claim one on
anybody's behalf. What the application does is refuse to let the question go
unasked:

- every song carries `SongRights` — `unknown`, `publicDomain`, `licensed` or
  `restricted` — with the terms verbatim and where the words came from;
- the search results show that status, so an operator scanning a list can see
  which songs they may actually use;
- the preview pane shows it again, with the terms, at the moment somebody is
  deciding;
- `unknown` says *nobody has checked*, rather than implying it is fine;
- the church's own CCLI song number is a field they fill, kept for their
  reporting and sent nowhere.

**Open, and mine to flag rather than to decide:** distributing copyrighted
lyrics to other churches is a licensed activity, whoever assembled the corpus
and however it was exported. Public-domain hymns are unencumbered and could
ship today. Anything under copyright needs an agreement — the three enquiry
drafts in `docs/lyrics-licensing-enquiries.md` (LyricFind, Musixmatch, CCLI) are
the path to one, and they are still unsent. Shipping a corpus of copyrighted
songs before one of those answers would put the churches using it in a position
they did not choose.

A defensible first release: public-domain hymns and anything the copyright
holder has given us in writing, everything else marked `unknown` and absent
rather than present-but-unchecked.

## What the app already does

- `src-tauri/src/songfinder.rs` — the client: search, fetch, and turning a
  catalogue song into an ordinary library item. The token is the same device
  token the hosted speech subscription uses.
- `songfinder_search`, `songfinder_get`, `songfinder_add` — the commands.
- `Song FinderPanel`, `ImportPreview` — the two panes in the Songs arrangement.
- A song added is the church's own from that moment: editable, exportable, and
  unaffected by anything that later happens to the subscription. Nothing points
  back at the catalogue, because a song a church has is not a licence they are
  renting.

## What the broker has to provide

Both under `/api/v1/songfinder/`, bearer-authenticated with the device token, and
refusing anything without an active entitlement.

```
GET /api/v1/songfinder/search?q=<query>&limit=<1..100>
    → { "hits": [ { id, title, author, opening, rights, sections } ] }

GET /api/v1/songfinder/songs/<id>
    → { id, title, author, sections: [ { label, lines } ], rights: {
          status, author, composer, terms, source, ccli } }
```

`rights.status` is one of `unknown | publicDomain | licensed | restricted`.
`opening` is the first line, which is how half a congregation names a song.

**The search has to be semantic, or the name is a lie.** Embed every song in
the corpus once — title, author and the words — and rank a query against those
vectors, keeping exact title and first-line matches on top where they exist.
"A song about waiting on God", "the one that goes way maker" and "Waymaker"
must all reach the same song. Ranking by keyword and calling it AI is the kind
of promise that is found out on a Sunday.

Two properties to hold to:

- **Nothing is generated at any point in the path.** The model ranks; it does
  not write, complete, correct or translate a lyric.
- **A poor match is an empty result, not a plausible one.** The nearest song
  to a query about something the catalogue does not contain is still a song,
  and offering it as an answer is how an operator stages the wrong thing. A
  floor, and silence below it.

## Still to build

1. **ProPresenter import** in `songs_import.rs`, which is both a feature
   churches want and the way the corpus arrives.
2. **An ingest step**: export → normalised JSON with rights per song. The
   importer already in Pulpitry is most of it; what is missing is the part that
   writes a catalogue file rather than library rows.
3. **The broker endpoints** in castavox-web, with the entitlement check.
4. **The licensing answer** before any copyrighted song is served.

The order matters: the search can be built and demonstrated against
public-domain hymns alone, which is both a real corpus and one nothing is
risked on.
