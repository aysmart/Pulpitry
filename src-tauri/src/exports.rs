//! Turning a summary into something a church can send to somebody.
//!
//! The summary is Markdown, which is the only form stored. Everything here
//! converts from it, so there is one representation to get right and the stored
//! thing stays readable on its own.
//!
//! Four outputs, because a church needs different ones on different days:
//!
//!   Markdown  what it already is, for anyone who wants it verbatim
//!   Text      to paste into an email or a message
//!   Word      to edit before it goes in a newsletter
//!   PDF       to send to somebody who should not edit it
//!
//! # The Markdown understood here
//!
//! Headings, bullets, bold, italics and paragraphs. That is what the model is
//! asked for and all a summary needs. Anything else is passed through as its
//! own text rather than dropped, so an unexpected construct costs a reader a
//! stray asterisk instead of a missing sentence.

use std::io::{Cursor, Write};

use anyhow::{Context, Result};

/// One piece of a parsed document.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u8, text: String },
    Paragraph(String),
    Bullet(String),
}

/// Reads the small subset of Markdown a summary uses.
pub fn parse(markdown: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph = String::new();

    let flush = |paragraph: &mut String, blocks: &mut Vec<Block>| {
        let text = paragraph.trim().to_string();
        if !text.is_empty() {
            blocks.push(Block::Paragraph(text));
        }
        paragraph.clear();
    };

    for line in markdown.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            flush(&mut paragraph, &mut blocks);
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('#') {
            let level = 1 + rest.chars().take_while(|c| *c == '#').count() as u8;
            let text = rest.trim_start_matches('#').trim();
            if !text.is_empty() {
                flush(&mut paragraph, &mut blocks);
                blocks.push(Block::Heading { level: level.min(6), text: text.to_string() });
                continue;
            }
        }

        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Bullet(rest.trim().to_string()));
            continue;
        }

        // A wrapped line continues the paragraph rather than starting one:
        // Markdown treats a single newline as a space.
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(trimmed);
    }

    flush(&mut paragraph, &mut blocks);
    blocks
}

/// Strips the emphasis markers from a run of text.
///
/// Only the markers, and only when they are markers: the words between them are
/// what the reader wants, and a format that cannot show bold should still show
/// the sentence.
///
/// A marker with nothing closing it is the character it looks like, and an
/// underscore inside a word is an underscore, as CommonMark has it. Stripping
/// every asterisk and underscore instead would quietly turn "2 * 3" into "2 3"
/// and a file name into one word. The same rule as the app's own reader
/// (`src/lib/markdown.ts`), so what is exported reads as what was shown.
pub fn plain(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let is_word = |index: usize| chars.get(index).is_some_and(|c| c.is_alphanumeric());

    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '`' {
            i += 1;
            continue;
        }
        if c != '*' && c != '_' {
            out.push(c);
            i += 1;
            continue;
        }

        let width = if chars.get(i + 1) == Some(&c) { 2 } else { 1 };
        let close = (i + width..chars.len().saturating_sub(width - 1))
            .find(|&at| chars[at..at + width].iter().all(|&other| other == c));

        // Unclosed, empty, or an underscore joining two halves of a word.
        let emphasis = close.filter(|&close| {
            close > i + width
                && !(c == '_' && (is_word(i.wrapping_sub(1)) || is_word(close + width)))
        });
        match emphasis {
            // The run between the markers, taken as it stands: the closing
            // marker is consumed here rather than met again as a stray one.
            Some(close) => {
                out.extend(&chars[i + width..close]);
                i = close + width;
            }
            None => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// The whole thing as plain text.
pub fn to_text(title: &str, markdown: &str, topics: &[String]) -> String {
    let mut out = String::new();
    if !title.is_empty() {
        out.push_str(title);
        out.push('\n');
        // Underlined rather than left bare: without any markup a title is
        // indistinguishable from the first line of the summary.
        out.push_str(&"=".repeat(title.chars().count()));
        out.push_str("\n\n");
    }

    // A list is written one line per item and closed with a blank line when it
    // ends. Without that the last bullet runs straight into the next heading.
    let mut in_list = false;
    for block in parse(markdown) {
        if in_list && !matches!(block, Block::Bullet(_)) {
            out.push('\n');
            in_list = false;
        }
        match block {
            Block::Heading { text, .. } => {
                out.push_str(&plain(&text));
                out.push('\n');
                out.push_str(&"-".repeat(text.chars().count()));
                out.push_str("\n\n");
            }
            Block::Paragraph(text) => {
                out.push_str(&plain(&text));
                out.push_str("\n\n");
            }
            Block::Bullet(text) => {
                out.push_str("  • ");
                out.push_str(&plain(&text));
                out.push('\n');
                in_list = true;
            }
        }
    }
    if in_list {
        out.push('\n');
    }

    if !topics.is_empty() {
        out.push_str("\nSubjects: ");
        out.push_str(&topics.join(", "));
        out.push('\n');
    }
    out
}

/// A minimal but valid .docx.
///
/// The format is a zip holding four files: the content types, a relationship
/// pointing at the document, and the document itself. Written by hand because
/// that is genuinely all Word needs, and a document-model crate to produce
/// three fixed XML files would be a poor trade.
pub fn to_docx(title: &str, markdown: &str, topics: &[String]) -> Result<Vec<u8>> {
    let mut body = String::new();

    if !title.is_empty() {
        body.push_str(&docx_paragraph(title, "Title"));
    }
    for block in parse(markdown) {
        match block {
            Block::Heading { level, text } => {
                body.push_str(&docx_paragraph(&plain(&text), &format!("Heading{}", level.min(3))));
            }
            Block::Paragraph(text) => body.push_str(&docx_paragraph(&plain(&text), "Normal")),
            Block::Bullet(text) => body.push_str(&docx_bullet(&plain(&text))),
        }
    }
    if !topics.is_empty() {
        body.push_str(&docx_paragraph("Subjects", "Heading2"));
        body.push_str(&docx_paragraph(&topics.join(", "), "Normal"));
    }

    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}<w:sectPr/></w:body></w:document>"#
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let mut buffer = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (name, contents) in [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", rels),
            ("word/document.xml", document.as_str()),
        ] {
            zip.start_file(name, options).context("could not write the Word file")?;
            zip.write_all(contents.as_bytes()).context("could not write the Word file")?;
        }
        zip.finish().context("could not finish the Word file")?;
    }
    Ok(buffer.into_inner())
}

fn docx_paragraph(text: &str, style: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        escape_xml(text)
    )
}

fn docx_bullet(text: &str) -> String {
    // A literal bullet rather than a numbering definition: real list numbering
    // needs numbering.xml and a style part, and this reads identically for a
    // document nobody is going to renumber.
    format!(
        r#"<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">• {}</w:t></w:r></w:p>"#,
        escape_xml(text)
    )
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A PDF, laid out at A4 with the text wrapped by hand.
pub fn to_pdf(title: &str, markdown: &str, topics: &[String]) -> Result<Vec<u8>> {
    use printpdf::*;

    // A4 in millimetres, with margins wide enough to read comfortably.
    const W: f32 = 210.0;
    const H: f32 = 297.0;
    const LEFT: f32 = 20.0;
    const RIGHT: f32 = 20.0;
    const TOP: f32 = 20.0;
    const BOTTOM: f32 = 20.0;

    let (document, page, layer) =
        PdfDocument::new(if title.is_empty() { "Summary" } else { title }, Mm(W), Mm(H), "Layer 1");
    let regular = document
        .add_builtin_font(BuiltinFont::Helvetica)
        .context("could not load a font for the PDF")?;
    let bold = document
        .add_builtin_font(BuiltinFont::HelveticaBold)
        .context("could not load a font for the PDF")?;

    let mut current = document.get_page(page).get_layer(layer);
    let mut y = H - TOP;

    // Helvetica's average character is about half its point size; good enough
    // to wrap a paragraph without shipping font metrics.
    let usable = W - LEFT - RIGHT;
    let mut write = |current: &mut PdfLayerReference,
                     y: &mut f32,
                     text: &str,
                     size: f32,
                     is_bold: bool,
                     indent: f32| {
        let per_char = size * 0.35 / 2.83465;
        let columns = ((usable - indent) / per_char).max(10.0) as usize;
        for line in wrap(text, columns) {
            if *y < BOTTOM {
                let (next, next_layer) = document.add_page(Mm(W), Mm(H), "Layer 1");
                *current = document.get_page(next).get_layer(next_layer);
                *y = H - TOP;
            }
            current.use_text(
                line,
                size,
                Mm(LEFT + indent),
                Mm(*y),
                if is_bold { &bold } else { &regular },
            );
            *y -= size * 0.55;
        }
    };

    if !title.is_empty() {
        write(&mut current, &mut y, title, 20.0, true, 0.0);
        y -= 4.0;
    }

    for block in parse(markdown) {
        match block {
            Block::Heading { level, text } => {
                y -= 3.0;
                let size = if level <= 2 { 14.0 } else { 12.0 };
                write(&mut current, &mut y, &plain(&text), size, true, 0.0);
                y -= 1.5;
            }
            Block::Paragraph(text) => {
                write(&mut current, &mut y, &plain(&text), 11.0, false, 0.0);
                y -= 3.0;
            }
            Block::Bullet(text) => {
                write(&mut current, &mut y, &format!("• {}", plain(&text)), 11.0, false, 5.0);
                y -= 1.0;
            }
        }
    }

    if !topics.is_empty() {
        y -= 4.0;
        write(&mut current, &mut y, "Subjects", 14.0, true, 0.0);
        y -= 1.5;
        write(&mut current, &mut y, &topics.join(", "), 11.0, false, 0.0);
    }

    document.save_to_bytes().context("could not write the PDF")
}

/// Breaks text into lines of at most `columns` characters, on word boundaries.
fn wrap(text: &str, columns: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();

    for word in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(word);
        } else if line.chars().count() + 1 + word.chars().count() <= columns {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    if lines.is_empty() {
        // One empty line rather than none: a blank paragraph should still take
        // up its space rather than closing the gap around it.
        lines.push(String::new());
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "He taught on the prodigal son.\n\n\
        ## Main points\n\n- The father ran\n- The elder brother stayed outside\n\n\
        ## Passages\n\nLuke 15, and **Romans 5** in passing.";

    #[test]
    fn reads_the_shape_of_a_summary() {
        let blocks = parse(SAMPLE);
        assert_eq!(blocks[0], Block::Paragraph("He taught on the prodigal son.".into()));
        assert_eq!(blocks[1], Block::Heading { level: 2, text: "Main points".into() });
        assert_eq!(blocks[2], Block::Bullet("The father ran".into()));
        assert_eq!(blocks.len(), 6);
    }

    #[test]
    fn a_wrapped_line_stays_one_paragraph() {
        // Markdown treats a single newline as a space; breaking here would put
        // half a sentence on its own line in every export.
        let blocks = parse("one sentence\nsplit over two lines");
        assert_eq!(blocks, vec![Block::Paragraph("one sentence split over two lines".into())]);
    }

    #[test]
    fn a_marker_that_marks_nothing_is_left_alone() {
        // Stripping every asterisk would turn arithmetic into nonsense and a
        // file name into one word. Both come up in a transcript.
        assert_eq!(plain("2 * 3 is six"), "2 * 3 is six");
        assert_eq!(plain("read the notes_2026 file"), "read the notes_2026 file");
        assert_eq!(plain("an *unclosed run"), "an *unclosed run");
        assert_eq!(plain("**bold** and _quiet_"), "bold and quiet");
    }

    #[test]
    fn emphasis_markers_go_but_the_words_stay() {
        assert_eq!(plain("**Romans 5** and *grace*"), "Romans 5 and grace");
        // Underscores joining a word are part of it, not emphasis around it.
        assert_eq!(plain("a_variable_name"), "a_variable_name");
    }

    #[test]
    fn text_export_reads_as_a_document() {
        let text = to_text("Coming Home", SAMPLE, &["grace".into(), "return".into()]);
        assert!(text.starts_with("Coming Home\n==========="), "the title is underlined");
        assert!(text.contains("  • The father ran"));
        // A list is closed off before the next heading, not run into it.
        assert!(text.contains("outside\n\nPassages"), "{text}");
        assert!(text.contains("Subjects: grace, return"));
        assert!(!text.contains("**"), "no markers survive into plain text");
    }

    #[test]
    fn the_word_file_is_a_zip_word_can_open() {
        let bytes = to_docx("Coming Home", SAMPLE, &["grace".into()]).unwrap();
        assert_eq!(&bytes[..2], b"PK", "a .docx is a zip");

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("readable zip");
        let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        for required in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
            assert!(names.contains(&required.to_string()), "missing {required}");
        }

        let mut document = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        assert!(document.contains("Coming Home"));
        assert!(document.contains("The father ran"));
        assert!(!document.contains("**"), "markers must not reach the page");
    }

    #[test]
    fn xml_special_characters_do_not_break_the_word_file() {
        // A speaker saying "faith & works" would otherwise produce a file Word
        // refuses to open at all.
        let bytes = to_docx("Faith & Works", "He said <this> and \"that\".", &[]).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut document = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        assert!(document.contains("Faith &amp; Works"));
        assert!(document.contains("&lt;this&gt;"));
    }

    #[test]
    fn the_pdf_is_a_pdf() {
        let bytes = to_pdf("Coming Home", SAMPLE, &["grace".into()]).unwrap();
        assert_eq!(&bytes[..5], b"%PDF-");
        assert!(bytes.len() > 500, "suspiciously small for a page of text");
    }

    /// How many pages a PDF has, read back out of the file.
    ///
    /// Whitespace is stripped first because the writer is free to put it
    /// anywhere; and `/Type/Pages` -- the node listing them -- is not itself a
    /// page.
    fn pages(bytes: &[u8]) -> usize {
        let text: String =
            String::from_utf8_lossy(bytes).chars().filter(|c| !c.is_whitespace()).collect();
        text.match_indices("/Type/Page")
            .filter(|(at, _)| text[at + "/Type/Page".len()..].chars().next() != Some('s'))
            .count()
    }

    #[test]
    fn a_long_summary_runs_onto_more_than_one_page() {
        let long = (0..400)
            .map(|i| format!("Sentence number {i} of a long teaching."))
            .collect::<Vec<_>>()
            .join(" ");

        assert!(pages(&to_pdf("A long one", &long, &[]).unwrap()) > 1, "should have paginated");
        assert_eq!(pages(&to_pdf("A short one", "Just a line.", &[]).unwrap()), 1);
    }

    #[test]
    fn wrapping_breaks_on_words() {
        let lines = wrap("the quick brown fox jumps", 10);
        assert!(lines.iter().all(|l| l.chars().count() <= 10), "{lines:?}");
        assert_eq!(lines.join(" "), "the quick brown fox jumps");
    }

    #[test]
    fn a_word_longer_than_the_line_is_not_lost() {
        let lines = wrap("supercalifragilistic", 5);
        assert_eq!(lines, vec!["supercalifragilistic"], "better to overrun than to drop it");
    }
}
