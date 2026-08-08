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
//! Headings, paragraphs, bulleted and numbered lists at two depths,
//! blockquotes, horizontal rules, bold, italic and links. Enough for a summary
//! to read as a document rather than a wall of text -- and every construct
//! survives into Word and PDF as real formatting rather than as punctuation
//! stripped out on the way.
//!
//! Anything beyond it is passed through as its own text rather than dropped, so
//! an unexpected construct costs a reader a stray asterisk instead of a missing
//! sentence.

use std::io::{Cursor, Write};

use anyhow::{Context, Result};

/// One piece of a parsed document.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u8, text: Vec<Span> },
    Paragraph(Vec<Span>),
    /// `depth` is how far the item is nested; 0 is top level.
    Bullet { depth: u8, text: Vec<Span> },
    Numbered { depth: u8, number: usize, text: Vec<Span> },
    /// A quoted passage, already joined into one block.
    Quote(Vec<Span>),
    Table { head: Vec<Vec<Span>>, rows: Vec<Vec<Vec<Span>>> },
    /// A thematic break between sections.
    Rule,
}

/// A run of text with its emphasis.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Span {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
}

impl Span {
    /// Plain text, for the places that cannot show emphasis.
    pub fn plain(text: impl Into<String>) -> Self {
        Self { text: text.into(), ..Self::default() }
    }
}

/// Reads Markdown.
///
/// CommonMark with the GitHub extensions, by way of pulldown-cmark, because
/// that is the dialect people mean when they say Markdown and because a model
/// writing a summary will reach for every construct in it. The events are
/// folded into the small block model the three renderers share, so each of them
/// deals with "a bullet at depth 1" rather than with a stream of tags.
///
/// Constructs with no sensible place in a printed summary -- images, footnotes,
/// raw HTML -- contribute their text and nothing else, which is the same rule
/// as everywhere else here: never drop what was said.
pub fn parse(markdown: &str) -> Vec<Block> {
    use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

    let markdown = break_before_headings(markdown);

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);

    let mut blocks: Vec<Block> = Vec::new();

    // What we are inside of, and the text gathered so far.
    let mut runs: Vec<Span> = Vec::new();
    let mut style = Span::default();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut quoting = 0usize;
    let mut in_heading: Option<u8> = None;
    let mut in_code: Option<String> = None;
    let mut table: Option<(Vec<Vec<Span>>, Vec<Vec<Vec<Span>>>, Vec<Vec<Span>>, bool)> = None;

    let push_text = |runs: &mut Vec<Span>, style: &Span, text: &str| {
        if text.is_empty() {
            return;
        }
        match runs.last_mut() {
            Some(last)
                if last.bold == style.bold
                    && last.italic == style.italic
                    && last.strike == style.strike =>
            {
                last.text.push_str(text)
            }
            _ => runs.push(Span { text: text.to_string(), ..style.clone() }),
        }
    };

    for event in Parser::new_ext(&markdown, options) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                in_heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = in_heading.take() {
                    if !runs.is_empty() {
                        blocks.push(Block::Heading { level, text: std::mem::take(&mut runs) });
                    }
                }
            }

            Event::Start(Tag::List(first)) => {
                // A nested list arrives inside its parent item, before that
                // item has ended -- so the parent's own line must be written
                // now, or it would be printed after its own sub-points.
                if !lists.is_empty() && !runs.is_empty() {
                    finish_item(&mut blocks, &mut runs, &mut lists);
                }
                lists.push(first);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
            }
            Event::End(TagEnd::Item) => {
                if !runs.is_empty() {
                    finish_item(&mut blocks, &mut runs, &mut lists);
                }
            }

            Event::Start(Tag::BlockQuote(_)) => quoting += 1,
            Event::End(TagEnd::BlockQuote(_)) => {
                quoting = quoting.saturating_sub(1);
                if !runs.is_empty() {
                    blocks.push(Block::Quote(std::mem::take(&mut runs)));
                }
            }

            // A summary of a sermon has no code in it. If a model ever
            // fences something anyway, the words inside are still words the
            // speaker said, so they become an ordinary paragraph rather than
            // disappearing.
            Event::Start(Tag::CodeBlock(_)) => in_code = Some(String::new()),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(code) = in_code.take() {
                    let text = code.trim().to_string();
                    if !text.is_empty() {
                        blocks.push(Block::Paragraph(vec![Span::plain(text)]));
                    }
                }
            }

            Event::Start(Tag::Table(_)) => table = Some((Vec::new(), Vec::new(), Vec::new(), true)),
            Event::End(TagEnd::TableHead) => {
                if let Some((head, _, cells, heading)) = table.as_mut() {
                    *head = std::mem::take(cells);
                    *heading = false;
                }
            }
            Event::End(TagEnd::TableRow) => {
                if let Some((_, rows, cells, _)) = table.as_mut() {
                    rows.push(std::mem::take(cells));
                }
            }
            Event::End(TagEnd::TableCell) => {
                if let Some((_, _, cells, _)) = table.as_mut() {
                    cells.push(std::mem::take(&mut runs));
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some((head, rows, _, _)) = table.take() {
                    blocks.push(Block::Table { head, rows });
                }
            }

            Event::Start(Tag::Emphasis) => style.italic = true,
            Event::End(TagEnd::Emphasis) => style.italic = false,
            Event::Start(Tag::Strong) => style.bold = true,
            Event::End(TagEnd::Strong) => style.bold = false,
            Event::Start(Tag::Strikethrough) => style.strike = true,
            Event::End(TagEnd::Strikethrough) => style.strike = false,

            Event::Text(text) => match in_code.as_mut() {
                Some(code) => code.push_str(&text),
                None => push_text(&mut runs, &style, &text),
            },
            Event::Code(text) => push_text(&mut runs, &style, &text),
            // A hard break inside a paragraph, and the soft ones Markdown
            // treats as spaces.
            Event::SoftBreak => push_text(&mut runs, &style, " "),
            Event::HardBreak => push_text(&mut runs, &style, " "),

            Event::Rule => blocks.push(Block::Rule),
            // A ticked or unticked task list item, drawn as what it is.
            Event::TaskListMarker(done) => {
                push_text(&mut runs, &style, if done { "\u{2611} " } else { "\u{2610} " })
            }

            Event::End(TagEnd::Paragraph) => {
                if !runs.is_empty() {
                    let text = std::mem::take(&mut runs);
                    // A paragraph inside a quotation belongs to the quotation,
                    // which is closed when the quote ends.
                    if quoting > 0 {
                        runs = text;
                    } else {
                        blocks.push(Block::Paragraph(text));
                    }
                }
            }

            /*
             * Nothing here is a web page.
             *
             * A transcript that mentions "the <this> and the <that>" parses as
             * inline HTML, and dropping it would silently delete words the
             * speaker said. It is kept verbatim and escaped by whichever
             * renderer needs to, which is the same rule as everywhere else:
             * never lose what was said.
             */
            Event::Html(text) | Event::InlineHtml(text) => push_text(&mut runs, &style, &text),
            _ => {}
        }
    }

    if !runs.is_empty() {
        blocks.push(Block::Paragraph(runs));
    }
    blocks
}

/// Closes the list item currently being gathered.
///
/// Shared by the end of an item and the start of a nested list beneath one,
/// because those are the two moments a parent's own line becomes complete.
fn finish_item(blocks: &mut Vec<Block>, runs: &mut Vec<Span>, lists: &mut [Option<u64>]) {
    let depth = lists.len().saturating_sub(1).min(3) as u8;
    let text = std::mem::take(runs);
    match lists.last_mut() {
        Some(Some(number)) => {
            let at = *number;
            *number += 1;
            blocks.push(Block::Numbered { depth, number: at as usize, text });
        }
        _ => blocks.push(Block::Bullet { depth, text }),
    }
}

/// Puts a heading back on a line of its own.
///
/// Models are inconsistent about this: the same deployment will write
/// "...and the older son. ## Main points" on one run and break the line on the
/// next. CommonMark only recognises a heading at the start of a line -- quite
/// correctly -- so no parser will rescue this, and without the pre-pass the
/// marker reaches a church's newsletter as literal text mid-sentence.
fn break_before_headings(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len() + 16);

    for (index, line) in markdown.lines().enumerate() {
        if index > 0 {
            out.push('\n');
        }

        let chars: Vec<char> = line.chars().collect();
        let mut at = 0;
        while at < chars.len() {
            let starts_run = chars[at] == '#'
                // Preceded by a space, so this opens a word. Without that,
                // "C# by us" reads as a heading, and the second hash of a
                // perfectly ordinary "## Main points" splits its own line.
                && at > 0
                && chars[at - 1].is_whitespace()
                && chars[..at].iter().any(|c| !c.is_whitespace());

            if starts_run {
                let hashes = chars[at..].iter().take_while(|c| **c == '#').count();
                let spaced = matches!(chars.get(at + hashes), Some(c) if c.is_whitespace());
                if (1..=6).contains(&hashes) && spaced {
                    while out.ends_with(' ') {
                        out.pop();
                    }
                    out.push_str("\n\n");
                    out.extend(&chars[at..]);
                    at = chars.len();
                    continue;
                }
            }

            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

/// Spans as one string, for the places that cannot show emphasis.
pub fn plain(runs: &[Span]) -> String {
    runs.iter().map(|span| span.text.as_str()).collect()
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
        let listish = matches!(block, Block::Bullet { .. } | Block::Numbered { .. });
        if in_list && !listish {
            out.push('\n');
        }
        in_list = listish;

        match block {
            Block::Heading { level, text } => {
                let text = plain(&text);
                out.push_str(&text);
                out.push('\n');
                let rule = if level <= 2 { '-' } else { '.' };
                out.push_str(&rule.to_string().repeat(text.chars().count()));
                out.push_str("\n\n");
            }
            Block::Paragraph(text) => {
                out.push_str(&plain(&text));
                out.push_str("\n\n");
            }
            Block::Bullet { depth, text } => {
                out.push_str(&"    ".repeat(depth as usize));
                out.push_str(if depth == 0 { "  \u{2022} " } else { "  \u{2013} " });
                out.push_str(&plain(&text));
                out.push('\n');
            }
            Block::Numbered { depth, number, text } => {
                out.push_str(&"    ".repeat(depth as usize));
                out.push_str(&format!("  {number}. "));
                out.push_str(&plain(&text));
                out.push('\n');
            }
            Block::Quote(text) => {
                // The convention every mail client and terminal already reads.
                for line in wrap(&plain(&text), 70) {
                    out.push_str("  > ");
                    out.push_str(&line);
                    out.push('\n');
                }
                out.push('\n');
            }
            Block::Table { head, rows } => {
                out.push_str(&table_as_text(&head, &rows));
                out.push('\n');
            }
            Block::Rule => out.push_str("  ----------------------------------------\n\n"),
        }
    }
    if in_list {
        out.push('\n');
    }

    if !topics.is_empty() {
        out.push_str("Subjects: ");
        out.push_str(&topics.join(", "));
        out.push('\n');
    }
    out
}

/// A table drawn with spaces, columns sized to their widest cell.
///
/// Monospaced alignment rather than pipes: this output is read in a mail client
/// or pasted into a message, where a row of pipes is noise and a column that
/// lines up is the whole point.
fn table_as_text(head: &[Vec<Span>], rows: &[Vec<Vec<Span>>]) -> String {
    let columns = head.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
    if columns == 0 {
        return String::new();
    }

    let cell = |row: &[Vec<Span>], at: usize| row.get(at).map(|c| plain(c)).unwrap_or_default();

    let mut widths = vec![0usize; columns];
    for at in 0..columns {
        widths[at] = cell(head, at).chars().count();
        for row in rows {
            widths[at] = widths[at].max(cell(row, at).chars().count());
        }
    }

    let line = |row: &[Vec<Span>]| {
        let mut out = String::from("  ");
        for at in 0..columns {
            let text = cell(row, at);
            out.push_str(&text);
            if at + 1 < columns {
                out.push_str(&" ".repeat(widths[at].saturating_sub(text.chars().count()) + 2));
            }
        }
        out.push('\n');
        out
    };

    let mut out = String::new();
    if !head.is_empty() {
        out.push_str(&line(head));
        out.push_str("  ");
        out.push_str(&widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join("  "));
        out.push('\n');
    }
    for row in rows {
        out.push_str(&line(row));
    }
    out
}

/* -------------------------------------------------------------------- Word */

/// A minimal but valid .docx.
///
/// The format is a zip holding the content types, a relationship pointing at
/// the document, a stylesheet and the document itself. Written by hand because
/// that is genuinely all Word needs, and a document-model crate to produce four
/// fixed XML files would be a poor trade.
pub fn to_docx(title: &str, markdown: &str, topics: &[String]) -> Result<Vec<u8>> {
    let mut body = String::new();

    if !title.is_empty() {
        body.push_str(&docx_para(&[Span::plain(title)], "Title", 0, None));
    }

    for block in parse(markdown) {
        match block {
            Block::Heading { level, text } => {
                body.push_str(&docx_para(&text, &format!("Heading{}", level.min(3)), 0, None))
            }
            Block::Paragraph(text) => body.push_str(&docx_para(&text, "Normal", 0, None)),
            Block::Bullet { depth, text } => {
                let marker = if depth == 0 { "\u{2022}\u{a0}" } else { "\u{25e6}\u{a0}" };
                body.push_str(&docx_para(&text, "Normal", 360 + 360 * i32::from(depth), Some(marker)));
            }
            Block::Numbered { depth, number, text } => {
                let marker = format!("{number}.\u{a0}");
                body.push_str(&docx_para(&text, "Normal", 360 + 360 * i32::from(depth), Some(&marker)));
            }
            Block::Quote(text) => body.push_str(&docx_para(&text, "Quote", 720, None)),
            Block::Table { head, rows } => body.push_str(&docx_table(&head, &rows)),
            // A paragraph whose only content is a bottom border: how a
            // horizontal rule has always been done in Word.
            Block::Rule => body.push_str(
                r#"<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>"#,
            ),
        }
    }

    if !topics.is_empty() {
        body.push_str(&docx_para(&[Span::plain("Subjects")], "Heading2", 0, None));
        body.push_str(&docx_para(&[Span::plain(topics.join(", "))], "Normal", 0, None));
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
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let document_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;

    let mut buffer = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (name, contents) in [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", rels),
            ("word/_rels/document.xml.rels", document_rels),
            ("word/styles.xml", DOCX_STYLES),
            ("word/document.xml", document.as_str()),
        ] {
            zip.start_file(name, options).context("could not write the Word file")?;
            zip.write_all(contents.as_bytes()).context("could not write the Word file")?;
        }
        zip.finish().context("could not finish the Word file")?;
    }
    Ok(buffer.into_inner())
}

/// The styles the document refers to.
///
/// Named styles rather than direct formatting, so whoever edits the summary
/// before it goes in a newsletter can restyle the whole thing from Word's own
/// style pane instead of reformatting it paragraph by paragraph.
const DOCX_STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
  <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/>
  <w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
  <w:pPr><w:spacing w:after="240"/></w:pPr>
  <w:rPr><w:sz w:val="56"/><w:b/><w:color w:val="1F2328"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
  <w:pPr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
  <w:rPr><w:sz w:val="32"/><w:b/><w:color w:val="1F2328"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
  <w:pPr><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>
  <w:rPr><w:sz w:val="26"/><w:b/><w:color w:val="44546A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
  <w:pPr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr>
  <w:rPr><w:sz w:val="24"/><w:b/><w:i/><w:color w:val="44546A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/>
  <w:pPr><w:spacing w:before="120" w:after="160"/>
    <w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="C8CDD4"/></w:pBdr></w:pPr>
  <w:rPr><w:i/><w:color w:val="44546A"/></w:rPr></w:style>
</w:styles>"#;

/// One paragraph, with each run carrying its own emphasis.
fn docx_para(runs: &[Span], style: &str, indent: i32, marker: Option<&str>) -> String {
    let mut body = String::new();

    if let Some(marker) = marker {
        body.push_str(&format!(
            r#"<w:r><w:t xml:space="preserve">{}</w:t></w:r>"#,
            escape_xml(marker)
        ));
    }

    for span in runs {
        let mut properties = String::new();
        if span.bold {
            properties.push_str("<w:b/>");
        }
        if span.italic {
            properties.push_str("<w:i/>");
        }
        if span.strike {
            properties.push_str("<w:strike/>");
        }
        let properties = if properties.is_empty() {
            String::new()
        } else {
            format!("<w:rPr>{properties}</w:rPr>")
        };

        body.push_str(&format!(
            r#"<w:r>{properties}<w:t xml:space="preserve">{}</w:t></w:r>"#,
            escape_xml(&span.text)
        ));
    }

    // A hanging indent, so a wrapped bullet lines up under its own text rather
    // than under its marker.
    let indentation = if indent > 0 {
        format!(r#"<w:ind w:left="{indent}" w:hanging="360"/>"#)
    } else {
        String::new()
    };

    format!(r#"<w:p><w:pPr><w:pStyle w:val="{style}"/>{indentation}</w:pPr>{body}</w:p>"#)
}

/// A real Word table, so it can be edited as one rather than as fixed text.
fn docx_table(head: &[Vec<Span>], rows: &[Vec<Vec<Span>>]) -> String {
    let columns = head.len().max(rows.iter().map(Vec::len).max().unwrap_or(0));
    if columns == 0 {
        return String::new();
    }

    let cell = |content: Option<&Vec<Span>>, header: bool| {
        let runs: Vec<Span> = content
            .map(|spans| {
                spans.iter().cloned().map(|mut s| { s.bold |= header; s }).collect()
            })
            .unwrap_or_default();
        format!(
            r#"<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>{}</w:tc>"#,
            docx_para(&runs, "Normal", 0, None)
        )
    };

    let mut out = String::from(
        r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>
<w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="C8CDD4"/><w:left w:val="single" w:sz="4" w:color="C8CDD4"/>
<w:bottom w:val="single" w:sz="4" w:color="C8CDD4"/><w:right w:val="single" w:sz="4" w:color="C8CDD4"/>
<w:insideH w:val="single" w:sz="4" w:color="C8CDD4"/><w:insideV w:val="single" w:sz="4" w:color="C8CDD4"/>
</w:tblBorders></w:tblPr>"#,
    );

    if !head.is_empty() {
        out.push_str("<w:tr>");
        for at in 0..columns {
            out.push_str(&cell(head.get(at), true));
        }
        out.push_str("</w:tr>");
    }
    for row in rows {
        out.push_str("<w:tr>");
        for at in 0..columns {
            out.push_str(&cell(row.get(at), false));
        }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl><w:p/>");
    out
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/* --------------------------------------------------------------------- PDF */

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

    // Four faces, so bold and italic are drawn as bold and italic rather than
    // silently flattened the way a single-font layout would have to.
    let regular = document.add_builtin_font(BuiltinFont::Helvetica).context("font")?;
    let bold = document.add_builtin_font(BuiltinFont::HelveticaBold).context("font")?;
    let italic = document.add_builtin_font(BuiltinFont::HelveticaOblique).context("font")?;
    let bold_italic =
        document.add_builtin_font(BuiltinFont::HelveticaBoldOblique).context("font")?;

    let mut current = document.get_page(page).get_layer(layer);
    let mut y = H - TOP;

    // Helvetica's average character is about half its point size; good enough
    // to wrap a paragraph without shipping font metrics.
    let per_char = |size: f32| size * 0.35 / 2.83465;
    let usable = W - LEFT - RIGHT;
    let columns = |size: f32, indent: f32| ((usable - indent) / per_char(size)).max(10.0) as usize;

    let mut draw = |current: &mut PdfLayerReference,
                    y: &mut f32,
                    lines: Vec<Vec<Span>>,
                    size: f32,
                    indent: f32,
                    force_bold: bool,
                    quoted: bool| {
        for line in lines {
            if *y < BOTTOM {
                let (next, next_layer) = document.add_page(Mm(W), Mm(H), "Layer 1");
                *current = document.get_page(next).get_layer(next_layer);
                *y = H - TOP;
            }

            // The bar down the side of a quotation: a filled rectangle, which
            // is the whole of what a quote rule needs to be.
            if quoted {
                current.set_fill_color(Color::Rgb(Rgb::new(0.78, 0.80, 0.83, None)));
                current.add_rect(
                    Rect::new(
                        Mm(LEFT + indent - 4.0),
                        Mm(*y - size * 0.22),
                        Mm(LEFT + indent - 3.2),
                        Mm(*y + size * 0.30),
                    )
                    .with_mode(printpdf::path::PaintMode::Fill),
                );
                current.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
            }

            let mut x = LEFT + indent;
            for span in line {
                let font = match (span.bold || force_bold, span.italic) {
                    (true, true) => &bold_italic,
                    (true, false) => &bold,
                    (false, true) => &italic,
                    (false, false) => &regular,
                };
                current.use_text(&span.text, size, Mm(x), Mm(*y), font);
                x += span.text.chars().count() as f32 * per_char(size);
            }
            *y -= size * 0.55;
        }
    };

    if !title.is_empty() {
        let runs = [Span::plain(title)];
        draw(&mut current, &mut y, wrap_spans(&runs, columns(20.0, 0.0)), 20.0, 0.0, true, false);
        y -= 5.0;
    }

    for block in parse(markdown) {
        match block {
            Block::Heading { level, text } => {
                y -= 3.5;
                let size = if level <= 2 { 14.0 } else { 12.0 };
                let lines = wrap_spans(&text, columns(size, 0.0));
                draw(&mut current, &mut y, lines, size, 0.0, true, false);
                y -= 1.5;
            }
            Block::Paragraph(text) => {
                let lines = wrap_spans(&text, columns(11.0, 0.0));
                draw(&mut current, &mut y, lines, 11.0, 0.0, false, false);
                y -= 3.0;
            }
            Block::Bullet { depth, text } => {
                let indent = 5.0 + 6.0 * f32::from(depth);
                let mut runs = vec![Span::plain(if depth == 0 { "\u{2022}  " } else { "\u{25e6}  " })];
                runs.extend(text);
                let lines = wrap_spans(&runs, columns(11.0, indent));
                draw(&mut current, &mut y, lines, 11.0, indent, false, false);
                y -= 1.2;
            }
            Block::Numbered { depth, number, text } => {
                let indent = 5.0 + 6.0 * f32::from(depth);
                let mut runs =
                    vec![Span { text: format!("{number}.  "), bold: true, ..Span::default() }];
                runs.extend(text);
                let lines = wrap_spans(&runs, columns(11.0, indent));
                draw(&mut current, &mut y, lines, 11.0, indent, false, false);
                y -= 1.2;
            }
            Block::Quote(text) => {
                y -= 1.5;
                let runs: Vec<Span> =
                    text.into_iter().map(|s| Span { italic: true, ..s }).collect();
                let lines = wrap_spans(&runs, columns(11.0, 8.0));
                draw(&mut current, &mut y, lines, 11.0, 8.0, false, true);
                y -= 3.0;
            }
            Block::Table { head, rows } => {
                y -= 2.0;
                // One row per line with the columns spaced out. A ruled grid
                // would need column measurement this layout cannot do
                // honestly, and a table that does not line up is worse than a
                // list that does.
                let widths = |cells: &Vec<Vec<Span>>| cells.iter().map(|c| plain(c)).collect::<Vec<_>>();
                let all: Vec<Vec<String>> =
                    std::iter::once(&head).chain(rows.iter()).map(widths).collect();
                let count = all.iter().map(Vec::len).max().unwrap_or(0);
                let mut column_width = vec![0usize; count];
                for row in &all {
                    for (at, text) in row.iter().enumerate() {
                        column_width[at] = column_width[at].max(text.chars().count());
                    }
                }

                for (index, row) in all.iter().enumerate() {
                    let mut line = String::new();
                    for (at, text) in row.iter().enumerate() {
                        line.push_str(text);
                        if at + 1 < row.len() {
                            line.push_str(&" ".repeat(column_width[at] - text.chars().count() + 2));
                        }
                    }
                    let runs =
                        vec![Span { text: line, bold: index == 0 && !head.is_empty(), ..Span::default() }];
                    draw(&mut current, &mut y, vec![runs], 10.0, 4.0, false, false);
                }
                y -= 3.0;
            }
            Block::Rule => {
                y -= 3.0;
                // A hairline the width of the text column, filled rather than
                // stroked so its thickness does not depend on pen state.
                current.set_fill_color(Color::Rgb(Rgb::new(0.78, 0.80, 0.83, None)));
                current.add_rect(
                    Rect::new(Mm(LEFT), Mm(y), Mm(W - RIGHT), Mm(y + 0.3))
                        .with_mode(printpdf::path::PaintMode::Fill),
                );
                current.set_fill_color(Color::Rgb(Rgb::new(0.0, 0.0, 0.0, None)));
                y -= 5.0;
            }
        }
    }

    if !topics.is_empty() {
        y -= 5.0;
        let lines = wrap_spans(&[Span::plain("Subjects")], columns(14.0, 0.0));
        draw(&mut current, &mut y, lines, 14.0, 0.0, true, false);
        y -= 1.5;
        let lines = wrap_spans(&[Span::plain(topics.join(",  "))], columns(11.0, 0.0));
        draw(&mut current, &mut y, lines, 11.0, 0.0, false, false);
    }

    document.save_to_bytes().context("could not write the PDF")
}

/// Breaks a run of spans into lines of at most `columns` characters, on word
/// boundaries, keeping each word's emphasis with it.
fn wrap_spans(runs: &[Span], columns: usize) -> Vec<Vec<Span>> {
    let mut lines: Vec<Vec<Span>> = Vec::new();
    let mut line: Vec<Span> = Vec::new();
    let mut width = 0usize;

    for span in runs {
        for word in span.text.split_whitespace() {
            let needed = word.chars().count() + usize::from(!line.is_empty());

            if !line.is_empty() && width + needed > columns {
                lines.push(std::mem::take(&mut line));
                width = 0;
            }

            let text = if line.is_empty() { word.to_string() } else { format!(" {word}") };
            width += text.chars().count();

            match line.last_mut() {
                // Merged into the previous run when the emphasis matches, so a
                // sentence is drawn in one call rather than one per word.
                Some(last)
                    if last.bold == span.bold
                        && last.italic == span.italic
                        && last.strike == span.strike =>
                {
                    last.text.push_str(&text);
                }
                _ => line.push(Span { text, ..span.clone() }),
            }
        }
    }

    if !line.is_empty() {
        lines.push(line);
    }
    if lines.is_empty() {
        lines.push(vec![Span::default()]);
    }
    lines
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

    /// Everything a summary is likely to contain, in one document.
    const SAMPLE: &str = r#"He taught on the prodigal son.

## Main points

1. **The request** — asking for an inheritance is asking a living man to die.
2. **The welcome** — the father *ran*, which an elder man did not do.
   - And he never let the speech finish.

## Passages

- **Luke 15:11-32** — the whole parable.

> But when he was yet a great way off, his father saw him.

| Son | Where he was lost |
| --- | --- |
| Younger | The far country |
| Elder | The field |

---

### A note

Something ~~struck out~~ and something ***emphatic***.
"#;

    /// The text of a block, for assertions that do not care about emphasis.
    fn text_of(block: &Block) -> String {
        match block {
            Block::Heading { text, .. }
            | Block::Paragraph(text)
            | Block::Bullet { text, .. }
            | Block::Numbered { text, .. }
            | Block::Quote(text) => plain(text),
            Block::Table { .. } => "<table>".into(),
            Block::Rule => "<rule>".into(),
        }
    }

    #[test]
    fn reads_the_shape_of_a_summary() {
        let blocks = parse(SAMPLE);
        let shape: Vec<String> = blocks
            .iter()
            .map(|b| match b {
                Block::Heading { level, .. } => format!("h{level}"),
                Block::Paragraph(_) => "p".into(),
                Block::Bullet { depth, .. } => format!("bullet{depth}"),
                Block::Numbered { depth, number, .. } => format!("num{depth}:{number}"),
                Block::Quote(_) => "quote".into(),
                Block::Table { .. } => "table".into(),
                Block::Rule => "rule".into(),
            })
            .collect();

        assert_eq!(shape[0], "p");
        assert_eq!(shape[1], "h2");
        assert_eq!(shape[2], "num0:1");
        assert_eq!(shape[3], "num0:2");
        assert_eq!(shape[4], "bullet1", "the sub-point is nested: {shape:?}");
        assert!(shape.contains(&"quote".to_string()));
        assert!(shape.contains(&"table".to_string()));
        assert!(shape.contains(&"rule".to_string()));
        assert!(shape.contains(&"h3".to_string()));
    }

    #[test]
    fn a_table_keeps_its_head_and_its_rows() {
        let table = parse(SAMPLE)
            .into_iter()
            .find_map(|b| match b {
                Block::Table { head, rows } => Some((head, rows)),
                _ => None,
            })
            .expect("no table parsed");

        assert_eq!(plain(&table.0[0]), "Son");
        assert_eq!(plain(&table.0[1]), "Where he was lost");
        assert_eq!(table.1.len(), 2);
        assert_eq!(plain(&table.1[1][0]), "Elder");
    }

    #[test]
    fn emphasis_survives_as_emphasis_rather_than_being_stripped() {
        let blocks = parse("The father **ran** to meet *him*.");
        let Block::Paragraph(runs) = &blocks[0] else { panic!("{blocks:?}") };
        assert!(runs.iter().any(|s| s.text == "ran" && s.bold));
        assert!(runs.iter().any(|s| s.text == "him" && s.italic));
        assert_eq!(plain(runs), "The father ran to meet him.");
    }

    #[test]
    fn bold_and_italic_and_struck_through_all_survive() {
        let blocks = parse("Something ~~struck out~~ and something ***emphatic***.");
        let Block::Paragraph(runs) = &blocks[0] else { panic!() };
        assert!(runs.iter().any(|s| s.text == "struck out" && s.strike));
        assert!(runs.iter().any(|s| s.text == "emphatic" && s.bold && s.italic));
    }

    #[test]
    fn a_link_keeps_its_words_and_drops_its_address() {
        let blocks = parse("see [Luke 15](https://example.com/luke15) today");
        assert_eq!(text_of(&blocks[0]), "see Luke 15 today");
        assert!(!text_of(&blocks[0]).contains("http"));
    }

    #[test]
    fn a_paragraph_that_is_only_prose_stays_one_paragraph() {
        // A single newline is a space in Markdown, not a new block.
        let blocks = parse("He taught on the prodigal.\nAnd on the elder brother.");
        assert_eq!(blocks.len(), 1);
        assert_eq!(text_of(&blocks[0]), "He taught on the prodigal. And on the elder brother.");
    }

    #[test]
    fn a_heading_stuck_to_a_sentence_is_still_a_heading() {
        // Seen from a real deployment: the model ended a paragraph and opened
        // "## Main points" on the same line, which CommonMark reads as prose.
        let blocks = parse("He taught on the prodigal. ## Main points\n- The father ran.");
        assert_eq!(text_of(&blocks[0]), "He taught on the prodigal.");
        assert!(matches!(blocks[1], Block::Heading { level: 2, .. }));
        assert!(matches!(blocks[2], Block::Bullet { depth: 0, .. }));
    }

    #[test]
    fn a_hash_that_is_not_a_heading_is_left_alone() {
        assert_eq!(text_of(&parse("Sing hymn #12 today")[0]), "Sing hymn #12 today");
        assert_eq!(text_of(&parse("written in C# by us")[0]), "written in C# by us");
    }

    #[test]
    fn a_fenced_block_keeps_its_words_even_though_we_do_not_expect_one() {
        let blocks = parse("Before.\n\n```\nHe said this.\n```\n\nAfter.");
        let all: Vec<String> = blocks.iter().map(text_of).collect();
        assert!(all.iter().any(|t| t.contains("He said this.")), "{all:?}");
    }

    #[test]
    fn text_export_reads_as_a_document() {
        let text = to_text("Coming Home", SAMPLE, &["grace".into(), "return".into()]);
        assert!(text.starts_with("Coming Home\n==========="), "the title is underlined");
        assert!(text.contains("  1. The request"), "numbers are kept: {text}");
        assert!(text.contains("\u{2013} And he never let the speech finish"), "nesting shows");
        assert!(text.contains("  > But when he was yet"), "a quote is marked as one");
        assert!(text.contains("Younger"), "the table is written out");
        assert!(text.contains("Subjects: grace, return"));
        // Emphasis markers must not survive into a plain-text export.
        assert!(!text.contains("**"), "{text}");
        assert!(!text.contains("~~"), "{text}");
    }

    #[test]
    fn the_word_file_is_a_zip_word_can_open() {
        let bytes = to_docx("Coming Home", SAMPLE, &["grace".into()]).unwrap();
        assert_eq!(&bytes[..2], b"PK");

        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<String> =
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        for needed in ["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/document.xml"]
        {
            assert!(names.contains(&needed.to_string()), "{needed} missing from {names:?}");
        }
    }

    #[test]
    fn the_word_file_carries_real_formatting() {
        let bytes = to_docx("Coming Home", SAMPLE, &[]).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut document = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();

        assert!(document.contains("<w:b/>"), "bold reaches Word as bold");
        assert!(document.contains("<w:i/>"), "italic reaches Word as italic");
        assert!(document.contains("<w:strike/>"), "strikethrough survives");
        assert!(document.contains(r#"<w:pStyle w:val="Heading2"/>"#), "headings are headings");
        assert!(document.contains(r#"<w:pStyle w:val="Quote"/>"#), "the quotation is styled");
        assert!(document.contains("<w:tbl>"), "the table is a real Word table");
        assert!(document.contains("<w:pBdr>"), "the rule is drawn");
        // The markers must not survive as literal text beside the formatting.
        assert!(!document.contains("**"), "asterisks leaked into the document");
    }

    #[test]
    fn xml_special_characters_do_not_break_the_word_file() {
        let bytes = to_docx("Faith & Works", "A <this> and \"that\" & more.", &[]).unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut document = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut document).unwrap();
        assert!(document.contains("Faith &amp; Works"));
        assert!(document.contains("&lt;this&gt;"));
    }

    /// How many pages a PDF has, read back out of the file.
    fn pages(bytes: &[u8]) -> usize {
        let text: String =
            String::from_utf8_lossy(bytes).chars().filter(|c| !c.is_whitespace()).collect();
        text.match_indices("/Type/Page")
            .filter(|(at, _)| text[at + "/Type/Page".len()..].chars().next() != Some('s'))
            .count()
    }

    #[test]
    fn the_pdf_is_a_pdf() {
        let bytes = to_pdf("Coming Home", SAMPLE, &["grace".into()]).unwrap();
        assert_eq!(&bytes[..5], b"%PDF-");
        assert!(bytes.len() > 500, "suspiciously small for a page of text");
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
    fn wrapping_keeps_each_word_with_its_own_emphasis() {
        let runs = vec![
            Span::plain("the "),
            Span { text: "quick brown".into(), bold: true, ..Span::default() },
            Span::plain(" fox jumps over"),
        ];
        let lines = wrap_spans(&runs, 12);
        assert!(lines.len() > 1, "{lines:?}");

        // Each line is its own run of text; the break between them is where the
        // space went, so rejoin before comparing.
        let rebuilt = lines
            .iter()
            .map(|line| line.iter().map(|s| s.text.as_str()).collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            rebuilt.split_whitespace().collect::<Vec<_>>().join(" "),
            "the quick brown fox jumps over"
        );
        assert!(lines.iter().flatten().any(|s| s.bold && s.text.contains("quick")));
    }

    #[test]
    fn a_word_longer_than_the_line_is_not_lost() {
        assert_eq!(
            wrap("supercalifragilistic", 5),
            vec!["supercalifragilistic"],
            "better to overrun than to drop it"
        );
    }
}
