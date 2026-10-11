# Where the Song Finder's songs come from

A new scrape arrived in October 2026 offering 105,637 songs against the
12,333 the bank ships today. It is not usable as it stands, and the reason is
worth writing down because the next scrape will have the same shape.

## What happened

`gospel_lyrics_scraper` has a `--discover` mode that searched Genius's whole
corpus for "worship", "praise", "gospel" and "hymn" and kept everything that
came back — the code said "IRRESPECTIVE OF ARTIST". Genius answers those
queries with most of popular music, because most of popular music mentions
heaven at some point.

The result was a general music catalogue with gospel mixed into it: Billy
Joel, Kanye West, K-pop, a great deal of rap, and rows like
`deletethisisis — Deleted Artist`. **8.8% of it carried explicit lyrics.**

Two fixes went in:

- **The scraper** now checks each credit against `gospel_artists.txt` and
  skips anything off the list.
- **The bank builder** rejects explicit language outright, in a test separate
  from the worship sieve, which `keep.txt` cannot override. A name in that
  file says "this church sings this" — a judgement about repertoire, not
  permission to put explicit language on a wall.

Together those take 105,637 → about 40,500. Each caught one layer and
exposed the next.

## What is still wrong, and why no filter fixes it

| Stage | Songs | What survives that should not |
| --- | --- | --- |
| Raw export | 105,637 | 8.8% explicit; most of popular music |
| + artist gate | 61,548 | whole catalogues of artists who recorded *some* gospel |
| + explicit filter | ~60,500 | the same |
| + worship sieve | 40,547 | ~1,600 secular songs from six artists alone |
| + a tightened sieve | 36,630 | still ~1,083 |

Survivors in a real run included *A Night in Tunisia*, *(You Make Me Feel
Like) A Natural Woman*, *A Damn Good Country Song* and *19th Amendment*.

No word test separates Aretha Franklin singing a gospel standard from Aretha
Franklin singing about love with "Lord" in it. The filter is not the problem.

## The list is the problem, in two distinct ways

**It mixes two kinds of artist.** Acts whose entire catalogue is worship —
Hillsong, Elevation, Maverick City — sit beside artists who merely recorded
some gospel: Ella Fitzgerald (990 songs), Dolly Parton (788), Aretha Franklin
(695), Jerry Lee Lewis (576), Charley Pride, Loretta Lynn, Jim Reeves. The
scraper takes everything by anyone on it.

**It has at least one name collision.** Line 222's "Chris Brown" sits among
Elevation Worship's members and means theirs. It matched the R&B artist and
pulled 1,047 tracks, 535 of which the explicit filter then caught.

## The question underneath, which is a product decision

Ranking the list by how much of each catalogue names God does *not* separate
the two kinds, and a cut on that number would be wrong in both directions. The
20–39% band holds Stryper, Flyleaf, As I Lay Dying, Five Iron Frenzy and
Switchfoot — Christian rock, whose lyrics are oblique — and Soweto Gospel
Choir, which is low only because it sings in Zulu and the word list barely
covers it. Beside them sit Dolly Parton and Wayne Newton.

So the real question is not *is this Christian music?* but **would a
congregation sing this?** The Song Finder exists so an operator can find a
song to put on a wall. By that test a Skillet album and an Ella Fitzgerald
gospel record are both out, and the wanted set is much narrower than the
Christian music industry — worship, hymnody and gospel repertoire.

That is a decision about what the product is for. It is not one a word list
can make.

## What is on disk

- `/private/tmp/songbank/artists-to-review.txt` — all 614 artists with 20 or
  more songs, least religious catalogue first. Regenerate it rather than rely
  on it surviving a reboot.
- The 43 artists with 150+ songs and under half naming God account for 13,290
  songs between them, and about half of those artists are genuine Christian
  acts with oblique lyrics. That list is a prompt for a person, not a cut.

## Recommended

1. Split `gospel_artists.txt` in two: artists to take whole, and artists to
   take nothing from automatically. Decide by the congregational test above.
2. Fix the "Chris Brown" collision — qualify it, or key the list by Genius
   artist id rather than by name.
3. Re-scrape with the fixed gate rather than filtering this export: the gate
   only keeps what a bad crawl already collected.
4. Then build the pack. It takes about an hour for 40,000 songs and replaces
   what paying churches pull, so it is worth doing once, on the right input.
