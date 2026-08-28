#!/usr/bin/env python3
"""
Builds downloadable translation packs from a scraped-JSON source tree.

    python3 scripts/build-packs.py --source <repo>/json --out ../packs NIV ESV
    python3 scripts/build-packs.py --scrollmapper CPDV.json --out ../packs CPDV

Output, per translation, in the pack format the applications download:

    <ID>.tsv.gz   bookNumber \t bookName \t chapter \t verse \t text
    <ID>.json     the catalogue entry: name, year, language, verse count,
                  and the checksum bible.rs compares to decide a reimport

# Why this is separate from build-bible.mjs

That script builds what ships *inside* the application, and everything it
builds is public domain. These are not: they are the translations churches
actually project, carried as downloads rather than in the installer. Keeping
them in a separate script keeps that distinction visible in the tree rather
than in a comment somebody has to notice.

# What the source needs cleaning of

**Footnote markers.** The source was scraped from a reading site and the
footnote anchors came with it: "The sons of Noah:[a] Shem". On a projection
screen that is simply wrong, and it appears in seven of the ten. They are
stripped -- but carefully, because the Amplified Bible uses square brackets as
its entire editorial method, and "return [it] to Him" must survive.

Measured across all ten translations, every bracketed one- or two-letter token
is a footnote marker except in the AMP, whose genuine short amplifications are
`it`, `me`, `my`, `to` and `of` -- fifteen occurrences in the whole Bible. The
markers run as an unbroken sequence a, b, c ... aa, ab ... bx, so the rule is
that sequence and nothing else.

**Holes.** Four of the ten -- the NIV, its Anglicised edition, the CSB and
the NLT -- are missing whole runs of verses in the chapters that are lists:
Ezra 2 and Nehemiah 7 (the returning families), Joshua 12 (the defeated
kings), Numbers 1 (the census), 1 Chronicles 25. The source renders those as
tables and the scrape did not follow them, so the verses are absent from the
data rather than dropped here. About 140 verses each.

They are shipped anyway, because a church that asks for the NIV wants the NIV
and nobody projects Ezra 2. But the gap is counted against the KJV
versification and written into the catalogue, so the library can say it. A
translation that silently answers nothing for Joshua 12:24 is worse than one
that says up front which chapters it cannot do.

Scattered single absences are left uncounted: those are the verses modern
translations deliberately omit -- Matthew 17:21, Mark 7:16 -- and reporting an
editorial decision as damage would be wrong.

**Merged verses.** The Message merges heavily -- 478 ranges like "1-10" -- and
the NLT and TPT do it occasionally. Our schema holds one verse per row, so the
merged text is written to every verse in the range. An operator who types
Matthew 5:4 in The Message gets the paragraph that contains it, which is what
the translation actually says there; the alternative is a reference that
resolves to nothing, on a Sunday, with no explanation.
"""

import argparse
import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

# Our canonical order and spelling. The source directory names differ only by
# underscores and one book: it calls the Psalter "Psalm".
BOOKS = [
    "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua",
    "Judges", "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings",
    "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job",
    "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah",
    "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
    "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai",
    "Zechariah", "Malachi", "Matthew", "Mark", "Luke", "John", "Acts",
    "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians",
    "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
    "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James",
    "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation",
]
OLD_TESTAMENT = 39

# Books a Catholic Bible has and a Protestant one does not, in the order a
# parish reads them. The order is the point: putting these at the end would be a
# Protestant Bible with an appendix, which is not what anybody is reading from.
DEUTEROCANON = {
    "Tobit", "Judith", "Wisdom", "Sirach", "Baruch",
    "1 Maccabees", "2 Maccabees",
}

# The scrollmapper files spell some books their own way.
RENAME = {
    "Revelation of John": "Revelation",
    "Song of Songs": "Song of Solomon",
}

# What each pack calls itself. The year is the edition a church would name, not
# the first publication: a Bible bought today that says "NIV" is the 2011 text.
TRANSLATIONS = {
    "NIV":   ("New International Version", 2011),
    "NIVUK": ("New International Version (Anglicised)", 2011),
    "NKJV":  ("New King James Version", 1982),
    "ESV":   ("English Standard Version", 2016),
    "NLT":   ("New Living Translation", 2015),
    "NASB":  ("New American Standard Bible", 2020),
    "CSB":   ("Christian Standard Bible", 2017),
    "MSG":   ("The Message", 2002),
    "AMP":   ("Amplified Bible", 2015),
    "TPT":   ("The Passion Translation", 2020),
    "CPDV":  ("Catholic Public Domain Version", 2009),
}

# Translations whose canon is not the sixty-six. Their books are numbered in
# their own order, which is what `book_number` has always meant -- an order
# within one translation -- and is only now being asked to mean it.
CANON = {"CPDV": "catholic"}

# A bracketed footnote anchor: a, b, c ... aa, ab ... bx. Anything longer, and
# any two letters outside that sequence, is the Amplified Bible's own text.
FOOTNOTE = re.compile(r"\[(?:[a-z]|[a-c][a-z])\]")

# Whitespace the scrape left behind: a marker removed mid-sentence can leave a
# double space, and several verses arrive with a trailing one.
SPACES = re.compile(r"[ \t ]+")


def source_name(book: str) -> str:
    """Our book name as the source tree spells it."""
    return "Psalm" if book == "Psalms" else book.replace(" ", "_")


def clean(text: str) -> str:
    return SPACES.sub(" ", FOOTNOTE.sub("", text)).strip()


def verses(key: str) -> list[int]:
    """The verse numbers a key covers. "5" is one; "1-10" is ten."""
    if key.isdigit():
        return [int(key)]
    first, _, last = key.partition("-")
    if first.isdigit() and last.isdigit() and int(last) >= int(first):
        return list(range(int(first), int(last) + 1))
    return []


def versification(reference: Path) -> dict[tuple[int, int], set[int]]:
    """Which verses a complete Bible has, read from the bundled KJV.

    A yardstick rather than a rule. It is what lets "this pack is missing
    Joshua 12:9-24" be said at build time instead of discovered by an operator
    mid-service.
    """
    chapters: dict[tuple[int, int], set[int]] = {}
    with gzip.open(reference, "rt", encoding="utf-8") as handle:
        for line in handle:
            fields = line.rstrip("\n").split("\t")
            if len(fields) == 5:
                key = (int(fields[0]), int(fields[2]))
                chapters.setdefault(key, set()).add(int(fields[3]))
    return chapters


def gaps(complete: dict, have: dict) -> tuple[int, list[str]]:
    """Runs of three or more absent verses, and the chapters holding them.

    Three, because one or two missing together is an editorial omission and
    reporting those as damage would be wrong. A run is a chapter the scrape
    could not read.
    """
    total = 0
    chapters: list[tuple[int, str]] = []
    for (book, chapter), verses_there in complete.items():
        missing = sorted(verses_there - have.get((book, chapter), set()))
        if not missing:
            continue
        run: list[int] = []
        counted = 0
        for verse in [*missing, -1]:
            if run and verse == run[-1] + 1:
                run.append(verse)
                continue
            if len(run) >= 3:
                counted += len(run)
            run = [verse]
        if counted:
            total += counted
            chapters.append((counted, f"{BOOKS[book - 1]} {chapter}"))
    chapters.sort(reverse=True)
    return total, [name for _, name in chapters]


def from_scrollmapper(path: Path) -> tuple[list[str], dict]:
    """Reads a scrollmapper JSON Bible into `(books in order, verses by book)`.

    A different shape from the scraped tree the other translations come from --
    nested chapters rather than a file per chapter -- but the same three facts
    per verse, so it lands in the same builder.

    Roman numerals are spelled out in that file ("I Samuel"); ours are digits,
    and a reference somebody types is matched against what is in the database.
    """
    raw = json.loads(path.read_text(encoding="utf-8"))
    order: list[str] = []
    verses: dict[str, dict[int, dict[int, str]]] = {}

    for book in raw["books"]:
        name = book["name"]
        for numeral, digit in (("III ", "3 "), ("II ", "2 "), ("I ", "1 ")):
            if name.startswith(numeral):
                name = digit + name[len(numeral):]
                break
        name = RENAME.get(name, name)

        order.append(name)
        verses[name] = {
            chapter["chapter"]: {v["verse"]: v["text"] for v in chapter["verses"]}
            for chapter in book["chapters"]
        }
    return order, verses


def build_scrollmapper(path: Path, out: Path, code: str) -> dict:
    """Builds a pack whose canon is its own, in its own order.

    Numbered 1..n through the books as that Bible orders them, which is what
    `book_number` has always meant: an order within one translation. It only
    now matters, because until now every translation we shipped had the same
    sixty-six in the same order and the number looked universal.

    Anything past the canon is dropped. The file carries five appendices after
    Revelation -- the Prayer of Manasses, 1 and 2 Esdras, an additional Psalm,
    Laodiceans -- which are not in the Catholic canon and would read as a Bible
    with extra books in it.
    """
    name, year = TRANSLATIONS[code]
    order, verses = from_scrollmapper(path)

    # Everything up to and including the last canonical book. For the Catholic
    # canon that is Revelation, and the appendices sit after it.
    end = order.index("Revelation") + 1
    order = order[:end]

    rows: list[str] = []
    for number, book in enumerate(order, start=1):
        for chapter in sorted(verses[book]):
            for verse in sorted(verses[book][chapter]):
                text = clean(verses[book][chapter][verse])
                if text:
                    rows.append(f"{number}\t{book}\t{chapter}\t{verse}\t{text}")

    body = "".join(f"{row}\n" for row in rows)
    packed = gzip.compress(body.encode("utf-8"), 9, mtime=0)
    (out / f"{code}.tsv.gz").write_bytes(packed)

    added = [book for book in order if book in DEUTEROCANON]
    entry = {
        "id": code,
        "name": name,
        "year": year,
        "file": f"{code}.tsv.gz",
        "verseCount": len(rows),
        "checksum": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "sha256": hashlib.sha256(packed).hexdigest(),
        "bytes": len(packed),
        "language": "English",
        "missingVerses": 0,
    }
    if added:
        entry["note"] = (
            f"The Catholic canon: {len(order)} books, including "
            + ", ".join(added)
            + "."
        )

    (out / f"{code}.json").write_text(json.dumps(entry, indent=2) + "\n")
    print(
        f"{code:6} {len(rows):6} verses  {len(order):2} books  "
        f"{len(packed) / 1024 / 1024:4.2f} MB  {len(added)} deuterocanonical"
    )
    return entry


def build(source: Path, out: Path, code: str, complete: dict) -> dict:
    name, year = TRANSLATIONS[code]
    rows: list[str] = []
    present: list[str] = []
    stripped = 0

    for number, book in enumerate(BOOKS, start=1):
        testament = "old" if number <= OLD_TESTAMENT else "new"
        directory = source / code / testament / source_name(book)
        if not directory.is_dir():
            continue
        present.append(book)

        chapters = sorted(
            (int(p.stem), p) for p in directory.glob("*.json") if p.stem.isdigit()
        )
        for chapter, path in chapters:
            text = json.loads(path.read_text(encoding="utf-8"))
            # One row per verse. The Message's paragraph ranges overlap at
            # their boundaries -- "43-51" is followed by "51-54", because verse
            # 51 ends one paragraph and starts the next -- and two rows for one
            # verse would show it twice in a chapter and return it twice from a
            # lookup. The paragraph it appears in first wins.
            written: set[int] = set()
            # Sorted by first verse, so a merged range lands where it belongs
            # rather than wherever the JSON happened to put it.
            for key in sorted(text, key=lambda k: verses(k)[0] if verses(k) else 0):
                covered = verses(key)
                if not covered:
                    print(f"  {code} {book} {chapter}: skipping verse key {key!r}")
                    continue
                body = text[key]
                stripped += len(FOOTNOTE.findall(body))
                body = clean(body)
                if not body:
                    continue
                for verse in covered:
                    if verse in written:
                        continue
                    written.add(verse)
                    rows.append(f"{number}\t{book}\t{chapter}\t{verse}\t{body}")

    if not rows:
        raise SystemExit(f"{code}: nothing to build -- is --source right?")

    have: dict[tuple[int, int], set[int]] = {}
    for row in rows:
        book, _, chapter, verse, _ = row.split("\t", 4)
        have.setdefault((int(book), int(chapter)), set()).add(int(verse))

    body = "".join(f"{row}\n" for row in rows)
    packed = gzip.compress(body.encode("utf-8"), 9, mtime=0)
    (out / f"{code}.tsv.gz").write_bytes(packed)

    entry = {
        "id": code,
        "name": name,
        "year": year,
        "file": f"{code}.tsv.gz",
        "verseCount": len(rows),
        # What bible.rs stores to decide whether an installed copy is current.
        # Matches build-bible.mjs: sha256 of the text, first 16 hex.
        "checksum": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "sha256": hashlib.sha256(packed).hexdigest(),
        "bytes": len(packed),
        "language": "English",
    }

    # Say so where a translation is not a whole Bible, or the download looks
    # broken rather than partial. The Passion Translation has four Old
    # Testament books because that is all of it there is; the NIV and three
    # others are missing their list chapters because the scrape could not read
    # a table.
    notes = []
    if len(present) < len(BOOKS):
        missing_nt = [b for b in BOOKS[OLD_TESTAMENT:] if b not in present]
        if not missing_nt:
            kept = [b for b in BOOKS[:OLD_TESTAMENT] if b in present]
            notes.append(
                "New Testament complete. Old Testament: " + ", ".join(kept) + " only."
            )
        else:
            notes.append(f"{len(present)} of {len(BOOKS)} books.")

    absent, where = gaps(
        {k: v for k, v in complete.items() if BOOKS[k[0] - 1] in present}, have
    )
    if absent:
        # Named rather than explained. The four big ones are list chapters the
        # scrape could not read, but that is not true of every gap, and a note
        # that asserts a cause it does not know is worse than one that just
        # says which chapters are short.
        named = ", ".join(where[:3])
        more = "" if len(where) <= 3 else f" and {len(where) - 3} more"
        notes.append(f"{absent} verses absent from the source, in {named}{more}.")
    if notes:
        entry["note"] = " ".join(notes)
    entry["missingVerses"] = absent

    (out / f"{code}.json").write_text(json.dumps(entry, indent=2) + "\n")
    print(
        f"{code:6} {len(rows):6} verses  {len(present):2} books  "
        f"{len(packed) / 1024 / 1024:4.2f} MB  {stripped:5} marks removed  "
        f"{absent:5} absent"
    )
    return entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="the scraped json/ tree")
    parser.add_argument(
        "--scrollmapper",
        type=Path,
        help="a single scrollmapper JSON Bible, for a translation whose canon is its own",
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--reference",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "src-tauri/resources/KJV.tsv.gz",
        help="a complete Bible to measure gaps against",
    )
    parser.add_argument("codes", nargs="+")
    args = parser.parse_args()

    unknown = [c for c in args.codes if c not in TRANSLATIONS]
    if unknown:
        raise SystemExit(f"not translations this script knows: {', '.join(unknown)}")

    args.out.mkdir(parents=True, exist_ok=True)

    if args.scrollmapper:
        total = sum(
            build_scrollmapper(args.scrollmapper, args.out, code)["bytes"]
            for code in args.codes
        )
    else:
        if not args.source:
            raise SystemExit("one of --source or --scrollmapper is needed")
        complete = versification(args.reference)
        total = sum(
            build(args.source, args.out, code, complete)["bytes"] for code in args.codes
        )
    print(f"\n{len(args.codes)} translations, {total / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
