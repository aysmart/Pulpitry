//! Recognising a reference the speaker says out loud.
//!
//! "Turn with me to John chapter three verse sixteen" is the most predictable
//! thing anyone says in a service, and nothing else in the app catches it:
//! exact detection needs the verse's own words, meaning-matching needs the
//! meaning, and the model needs a round trip. This is plain parsing, so it is
//! both instant and safe to run on speech that is still being revised.
//!
//! Two things make it harder than it looks. Speech recognition writes numbers
//! as words, so "sixteen" and "twenty-eight" have to be read. And the same
//! spoken phrase can mean two references — "psalm one nineteen" is almost
//! certainly Psalm 119, while "john three sixteen" is certainly 3:16 — which
//! is resolved by asking the library which readings actually exist.

use serde::Serialize;

/// A reference as spoken, before it has been checked against the library.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpokenReference {
    /// Normalised book name as written in the library.
    pub book: String,
    /// Readings of the numbers, best guess first.
    pub readings: Vec<Reading>,
    /// The words this came from, for showing the operator.
    pub phrase: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub chapter: i64,
    pub verse: Option<i64>,
}

const UNITS: &[(&str, i64)] = &[
    ("one", 1), ("two", 2), ("three", 3), ("four", 4), ("five", 5), ("six", 6),
    ("seven", 7), ("eight", 8), ("nine", 9), ("ten", 10), ("eleven", 11),
    ("twelve", 12), ("thirteen", 13), ("fourteen", 14), ("fifteen", 15),
    ("sixteen", 16), ("seventeen", 17), ("eighteen", 18), ("nineteen", 19),
];

const TENS: &[(&str, i64)] = &[
    ("twenty", 20), ("thirty", 30), ("forty", 40), ("fifty", 50), ("sixty", 60),
    ("seventy", 70), ("eighty", 80), ("ninety", 90),
];

/// Ordinals in front of a book, however the recogniser wrote them.
const ORDINALS: &[(&str, i64)] = &[
    ("first", 1), ("1st", 1), ("one", 1), ("1", 1), ("i", 1),
    ("second", 2), ("2nd", 2), ("two", 2), ("2", 2), ("ii", 2),
    ("third", 3), ("3rd", 3), ("three", 3), ("3", 3), ("iii", 3),
];

fn word_value(token: &str) -> Option<i64> {
    if let Ok(number) = token.parse::<i64>() {
        return Some(number);
    }
    UNITS
        .iter()
        .chain(TENS.iter())
        .find(|(word, _)| *word == token)
        .map(|(_, value)| *value)
}

/// Collapses a run of number words into the numbers they name.
///
/// "twenty eight" is one number; "three sixteen" is two. The difference is
/// whether the words compose — tens absorb a following unit, and "hundred"
/// multiplies what came before.
fn read_numbers(tokens: &[String]) -> Vec<i64> {
    let mut numbers = Vec::new();
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "and" && !numbers.is_empty() {
            index += 1;
            continue;
        }
        let Some(value) = word_value(token) else { break };
        index += 1;

        let mut total = value;

        // "one hundred", "a hundred"
        if tokens.get(index).is_some_and(|next| next == "hundred") {
            total *= 100;
            index += 1;
            if tokens.get(index).is_some_and(|next| next == "and") {
                index += 1;
            }
            // "one hundred nineteen", "one hundred and twenty three"
            if let Some(rest) = tokens.get(index).and_then(|token| word_value(token)) {
                if rest < 100 {
                    total += rest;
                    index += 1;
                    if TENS.iter().any(|(_, value)| *value == rest) {
                        if let Some(unit) = tokens.get(index).and_then(|t| word_value(t)) {
                            if unit < 10 {
                                total += unit;
                                index += 1;
                            }
                        }
                    }
                }
            }
        } else if TENS.iter().any(|(_, tens)| *tens == value) {
            // "twenty eight"
            if let Some(unit) = tokens.get(index).and_then(|token| word_value(token)) {
                if unit < 10 {
                    total += unit;
                    index += 1;
                }
            }
        }

        numbers.push(total);
        if numbers.len() == 3 {
            break;
        }
    }

    numbers
}

/// Turns the numbers following a book name into candidate readings.
///
/// Ordered by how likely they are, but the caller decides: only the library
/// knows that Psalm 1 has no verse 19 while Psalm 119 exists.
fn readings_for(numbers: &[i64], had_chapter_word: bool, had_verse_word: bool) -> Vec<Reading> {
    match numbers {
        [] => Vec::new(),
        [chapter] => vec![Reading { chapter: *chapter, verse: None }],
        [chapter, verse, ..] => {
            let mut readings = vec![Reading { chapter: *chapter, verse: Some(*verse) }];
            // "psalm one nineteen" almost certainly means 119. Only worth
            // considering when the speaker did not say "chapter" or "verse",
            // which would have settled it.
            if !had_chapter_word && !had_verse_word && *chapter < 10 && *verse >= 10 {
                readings.push(Reading { chapter: chapter * 100 + verse, verse: None });
            }
            readings
        }
    }
}

/// Finds a reference the speaker named, scanning from the end.
///
/// The most recent one is what matters: a speaker who says "we saw this in
/// Romans, but turn to James chapter one" means James.
pub fn find_reference(text: &str, books: &[String]) -> Option<SpokenReference> {
    let raw: Vec<String> = text
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|c| c.is_alphanumeric() || *c == ':' || *c == '-')
                .flat_map(|c| c.to_lowercase())
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect();

    // Digits may arrive already punctuated as "3:16".
    let tokens: Vec<String> = raw
        .iter()
        .flat_map(|word| {
            if word.contains(':') {
                word.split(':').map(str::to_string).collect::<Vec<_>>()
            } else {
                vec![word.clone()]
            }
        })
        .filter(|word| !word.is_empty())
        .collect();

    for start in (0..tokens.len()).rev() {
        let Some((book, begin, after)) = match_book(&tokens, start, books) else { continue };

        let mut index = after;
        let mut had_chapter_word = false;
        let mut had_verse_word = false;
        let mut numbers: Vec<i64> = Vec::new();

        while index < tokens.len() && numbers.len() < 2 {
            match tokens[index].as_str() {
                "chapter" | "chapters" => {
                    had_chapter_word = true;
                    index += 1;
                }
                "verse" | "verses" => {
                    had_verse_word = true;
                    index += 1;
                }
                _ => {
                    let found = read_numbers(&tokens[index..]);
                    if found.is_empty() {
                        break;
                    }
                    // Consume what was read by re-scanning; cheaper than
                    // threading an index back out of the reader.
                    let mut consumed = 0;
                    let mut taken = 0;
                    while taken < found.len() && index + consumed < tokens.len() {
                        let token = &tokens[index + consumed];
                        if token == "and" || token == "hundred" || word_value(token).is_some() {
                            consumed += 1;
                            if word_value(token).is_some()
                                && read_numbers(&tokens[index..index + consumed]).len() > taken
                            {
                                taken = read_numbers(&tokens[index..index + consumed]).len();
                            }
                        } else {
                            break;
                        }
                    }
                    numbers.extend(found);
                    index += consumed.max(1);
                }
            }
        }

        if numbers.is_empty() {
            continue;
        }

        let readings = readings_for(&numbers, had_chapter_word, had_verse_word);
        if readings.is_empty() {
            continue;
        }

        return Some(SpokenReference {
            book,
            readings,
            phrase: tokens[begin..index.min(tokens.len())].join(" "),
        });
    }

    None
}

/// Matches a book name at `start`, including a spoken ordinal in front of it.
///
/// Returns the library's spelling, where the name began, and the index just
/// past it. The begin index can precede `start`: scanning runs backwards, so
/// "John" in "third John" is reached before the ordinal that qualifies it.
fn match_book(
    tokens: &[String],
    start: usize,
    books: &[String],
) -> Option<(String, usize, usize)> {
    let ordinal = ORDINALS
        .iter()
        .find(|(word, _)| *word == tokens[start])
        .map(|(_, value)| *value);
    let name_start = if ordinal.is_some() { start + 1 } else { start };
    if name_start >= tokens.len() {
        return None;
    }

    // Longest first, so "song of solomon" wins over nothing and
    // "corinthians" does not swallow a following number.
    for length in (1..=3.min(tokens.len() - name_start)).rev() {
        let words = &tokens[name_start..name_start + length];
        let spoken = match ordinal {
            Some(number) => format!("{number} {}", words.join(" ")),
            None => words.join(" "),
        };
        let needle = normalize(&spoken);
        if needle.is_empty() {
            continue;
        }
        if let Some(book) = books.iter().find(|book| normalize(book) == needle) {
            // A plain match may be the tail of an ordinal one. "third John"
            // must not be read as "John" simply because the scan met it first.
            if ordinal.is_none() && start > 0 {
                if let Some((_, value)) = ORDINALS
                    .iter()
                    .find(|(word, _)| *word == tokens[start - 1])
                {
                    let qualified = format!("{value} {}", words.join(" "));
                    let needle = normalize(&qualified);
                    if let Some(book) = books.iter().find(|book| normalize(book) == needle) {
                        return Some((book.clone(), start - 1, name_start + length));
                    }
                }
            }
            return Some((book.clone(), start, name_start + length));
        }
    }
    None
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn books() -> Vec<String> {
        [
            "Genesis", "Exodus", "Psalms", "Isaiah", "Matthew", "Mark", "Luke", "John",
            "Acts", "Romans", "1 Corinthians", "2 Corinthians", "Ephesians",
            "1 Timothy", "2 Timothy", "Hebrews", "James", "1 John", "2 John", "3 John",
            "Revelation", "Song of Solomon", "1 Samuel", "2 Samuel",
        ]
        .iter()
        .map(|book| book.to_string())
        .collect()
    }

    fn find(text: &str) -> Option<SpokenReference> {
        find_reference(text, &books())
    }

    fn best(text: &str) -> (String, i64, Option<i64>) {
        let found = find(text).expect("should find a reference");
        let first = found.readings[0];
        (found.book, first.chapter, first.verse)
    }

    #[test]
    fn reads_chapter_and_verse_spelled_out() {
        assert_eq!(
            best("turn with me to John chapter three verse sixteen"),
            ("John".into(), 3, Some(16))
        );
    }

    #[test]
    fn reads_a_bare_chapter_and_verse() {
        assert_eq!(best("look at John three sixteen"), ("John".into(), 3, Some(16)));
    }

    #[test]
    fn reads_a_chapter_on_its_own() {
        assert_eq!(best("turn with me to Luke chapter three"), ("Luke".into(), 3, None));
    }

    #[test]
    fn reads_digits_when_the_recogniser_writes_them() {
        assert_eq!(best("open to John 3:16"), ("John".into(), 3, Some(16)));
        assert_eq!(best("open to Romans 8 28"), ("Romans".into(), 8, Some(28)));
    }

    #[test]
    fn reads_compound_numbers() {
        assert_eq!(best("Romans chapter eight verse twenty eight"), ("Romans".into(), 8, Some(28)));
        assert_eq!(best("Psalms chapter one hundred nineteen"), ("Psalms".into(), 119, None));
        assert_eq!(
            best("Psalms chapter one hundred and nineteen"),
            ("Psalms".into(), 119, None)
        );
    }

    #[test]
    fn reads_spoken_ordinals_in_book_names() {
        assert_eq!(best("first Corinthians chapter thirteen"), ("1 Corinthians".into(), 13, None));
        assert_eq!(best("second Timothy chapter three"), ("2 Timothy".into(), 3, None));
        assert_eq!(best("third John verse four"), ("3 John".into(), 4, None));
        assert_eq!(best("one Samuel chapter seventeen"), ("1 Samuel".into(), 17, None));
        assert_eq!(best("2 Corinthians chapter five"), ("2 Corinthians".into(), 5, None));
    }

    #[test]
    fn reads_multi_word_book_names() {
        assert_eq!(best("Song of Solomon chapter two"), ("Song of Solomon".into(), 2, None));
    }

    #[test]
    fn offers_the_run_together_reading_as_an_alternative() {
        // "psalm one nineteen" is almost certainly Psalm 119, but only the
        // library knows Psalm 1 has no verse 19.
        let found = find("turn to Psalms one nineteen").expect("should find");
        assert_eq!(found.readings[0], Reading { chapter: 1, verse: Some(19) });
        assert_eq!(found.readings[1], Reading { chapter: 119, verse: None });
    }

    #[test]
    fn saying_chapter_settles_the_ambiguity() {
        // "psalm chapter one verse nineteen" leaves nothing to guess at.
        let found = find("Psalms chapter one verse nineteen").expect("should find");
        assert_eq!(found.readings.len(), 1);
        assert_eq!(found.readings[0], Reading { chapter: 1, verse: Some(19) });
    }

    #[test]
    fn takes_the_most_recent_reference() {
        // The speaker has moved on; the earlier book is not where they are.
        assert_eq!(
            best("we saw this in Romans chapter five but now turn to James chapter one"),
            ("James".into(), 1, None)
        );
    }

    #[test]
    fn ignores_a_book_named_with_no_numbers() {
        // "the gospel of John tells us" is not an instruction to turn anywhere.
        assert!(find("the gospel of John tells us something important").is_none());
    }

    #[test]
    fn ignores_ordinary_speech() {
        assert!(find("good morning everyone and welcome to the service").is_none());
        assert!(find("there are three things I want to say this morning").is_none());
    }

    #[test]
    fn finds_a_reference_mid_sentence_before_it_is_finished() {
        // The whole point: this has to fire while the words are still arriving.
        assert_eq!(best("alright now turn with me to Ephesians chapter two"), ("Ephesians".into(), 2, None));
    }

    #[test]
    fn keeps_the_spoken_words_for_display() {
        let found = find("turn to Luke chapter three").expect("should find");
        assert!(found.phrase.contains("luke"));
        assert!(found.phrase.contains("three"));
    }
}

#[cfg(test)]
mod against_the_library {
    //! Resolution against the operator's real library.
    //!
    //!   cargo test --lib against_the_library -- --ignored --nocapture

    use super::*;
    use crate::bible::Library;

    fn library() -> Option<Library> {
        let home = std::env::var_os("HOME")?;
        let path = std::path::PathBuf::from(home)
            .join("Library/Application Support/com.pulpitry.desktop/pulpitry.db");
        path.exists().then(|| Library::open_read_only(&path).ok())?
    }

    #[test]
    #[ignore = "needs the imported library"]
    fn readings_are_settled_by_what_actually_exists() {
        let Some(library) = library() else { panic!("run the app once first") };
        let books: Vec<String> =
            library.books("KJV").expect("books").into_iter().map(|b| b.name).collect();

        let cases: &[(&str, &str, i64, Option<i64>)] = &[
            ("turn with me to John chapter three verse sixteen", "John", 3, Some(16)),
            ("look at John three sixteen", "John", 3, Some(16)),
            ("Romans chapter eight verse twenty eight", "Romans", 8, Some(28)),
            ("first Corinthians thirteen", "1 Corinthians", 13, None),
            // Psalm 1 stops at verse 6, so "one nineteen" can only be 119.
            ("turn to Psalms one nineteen", "Psalms", 119, None),
            // Genesis 1 does have a verse 26, so this stays chapter and verse.
            ("Genesis one twenty six", "Genesis", 1, Some(26)),
        ];

        println!();
        for (spoken, book, chapter, verse) in cases {
            let found = find_reference(spoken, &books).expect("should parse");
            let resolved = found
                .readings
                .iter()
                .find_map(|reading| {
                    library
                        .locate("KJV", &found.book, reading.chapter, reading.verse)
                        .ok()
                        .flatten()
                })
                .expect("should resolve");

            println!(
                "  {:<52} -> {} {}{}",
                format!("\"{spoken}\""),
                resolved.book,
                resolved.chapter,
                resolved.verse.map(|v| format!(":{v}")).unwrap_or_default()
            );

            assert_eq!(&resolved.book, book);
            assert_eq!(resolved.chapter, *chapter);
            assert_eq!(resolved.verse, *verse);
        }
        println!();
    }

    #[test]
    #[ignore = "needs the imported library"]
    fn an_impossible_reference_resolves_to_nothing() {
        let Some(library) = library() else { panic!("run the app once first") };
        let books: Vec<String> =
            library.books("KJV").expect("books").into_iter().map(|b| b.name).collect();

        // Jude has one chapter and 25 verses.
        let found = find_reference("Jude chapter nine", &books).expect("should parse");
        let resolved = found.readings.iter().find_map(|reading| {
            library.locate("KJV", &found.book, reading.chapter, reading.verse).ok().flatten()
        });
        assert!(resolved.is_none(), "invented a chapter that does not exist");
    }
}
