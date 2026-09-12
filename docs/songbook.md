# The Songbook

The catalogue of songs that comes with a Castavox subscription: titles, authors,
the words, and what is known about the rights to them. Searched from the Songs
arrangement, previewed before anything is added, and copied into the church's
own library one song at a time.

The name is deliberate. It is a songbook — the thing a church already has a
shelf of — and not "AI" anything: nothing here is generated, inferred or
guessed. Calling it magic would be claiming a capability we do not have and do
not want.

## Why it is the one thing behind a subscription

Everything else in Pulpitry runs on the machine and is unlimited: the local
engine, the verse library, the slide studio, imports from EasyWorship,
ProPresenter, OpenLP and OpenSong, and anything the church writes themselves.
That is the position and it should stay the position.

The Songbook is not on the machine. It is a catalogue somebody assembles,
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

- `src-tauri/src/songbook.rs` — the client: search, fetch, and turning a
  catalogue song into an ordinary library item. The token is the same device
  token the hosted speech subscription uses.
- `songbook_search`, `songbook_get`, `songbook_add` — the commands.
- `SongbookPanel`, `ImportPreview` — the two panes in the Songs arrangement.
- A song added is the church's own from that moment: editable, exportable, and
  unaffected by anything that later happens to the subscription. Nothing points
  back at the catalogue, because a song a church has is not a licence they are
  renting.

## What the broker has to provide

Both under `/api/v1/songbook/`, bearer-authenticated with the device token, and
refusing anything without an active entitlement.

```
GET /api/v1/songbook/search?q=<query>&limit=<1..100>
    → { "hits": [ { id, title, author, opening, rights, sections } ] }

GET /api/v1/songbook/songs/<id>
    → { id, title, author, sections: [ { label, lines } ], rights: {
          status, author, composer, terms, source, ccli } }
```

`rights.status` is one of `unknown | publicDomain | licensed | restricted`.
`opening` is the first line, which is how half a congregation names a song.
Search should read titles, authors *and* the words — a song is often catalogued
under a name nobody uses, and the line somebody remembers is the one they will
type.

## Still to build

1. **ProPresenter import** in `songs_import.rs`, which is both a feature
   churches want and the way the corpus arrives.
2. **An ingest step**: export → normalised JSON with rights per song. The
   importer already in Pulpitry is most of it; what is missing is the part that
   writes a catalogue file rather than library rows.
3. **The broker endpoints** in castavox-web, with the entitlement check.
4. **The licensing answer** before any copyrighted song is served.
