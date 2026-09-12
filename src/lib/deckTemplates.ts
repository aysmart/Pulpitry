import type { SongSection } from "./catalog";
import { componentText, layoutFor, type SlideComponent } from "./projector";

/**
 * Decks a church can put on a wall before they have made anything.
 *
 * The slide library opened empty, which is the wrong first impression for the
 * commonest job in the building: a welcome, this week's notices, the giving
 * details, a title card for the sermon. Every church needs those and none of
 * them is interesting to build, so they ship.
 *
 * # Why they are code rather than seeded rows
 *
 * The same reasoning as the sample looks in lib/templates.ts. A template is
 * *ours* — a church has not made it, cannot break it, and should not be able to
 * delete it by accident and lose it until the next install. Kept here they are
 * always present, cost no database, and need no migration when one is added or
 * a wording is improved. Copying one into the library is the act that makes it
 * the church's own, and from that moment it is an ordinary deck they can edit
 * and delete.
 *
 * # The text is deliberately placeholder
 *
 * Account numbers, times and days are written as the obvious blanks —
 * "0000000000", "Wednesday · 6:00 PM" — because a church that projects our
 * invented bank details has been failed by us, and a blank that looks like a
 * blank gets filled in. Nothing here is presented as a real church's anything.
 *
 * # Drawn by the real engine
 *
 * Each slide is components and a layout, not a picture of a slide, so it is
 * painted by the same renderer as a generated sermon deck — on the church's own
 * look, in their typeface, with their colours. Two consequences worth knowing:
 * a template inherits whatever theme is in use rather than carrying a design of
 * its own, and a slide that reads well in one look reads well in all of them.
 */
export interface DeckTemplate {
  id: string;
  title: string;
  /** What kind of thing it is, shown under the card: "Service", "Giving". */
  category: string;
  /** Said on hover — what it is for, not what is on it. */
  hint: string;
  sections: SongSection[];
}

/**
 * One slide, as components.
 *
 * `lines` is derived rather than written twice: anything that reads a section
 * as plain text — a search over slide text, a plan entry's label, an older
 * surface that predates components — gets the words without a second copy of
 * them to keep in step. The layout is asked of `layoutFor`, which is the same
 * function the renderer falls back to, so a template can never specify an
 * arrangement its own contents do not support.
 */
function slide(label: string, components: SlideComponent[]): SongSection {
  return {
    label,
    lines: components.map(componentText).filter(Boolean),
    components,
    layout: layoutFor(components),
  };
}

const title = (text: string): SlideComponent => ({
  kind: "text",
  text,
  level: "title",
});

const statement = (text: string): SlideComponent => ({
  kind: "text",
  text,
  level: "statement",
});

const body = (text: string): SlideComponent => ({
  kind: "text",
  text,
  level: "body",
});

export const DECK_TEMPLATES: DeckTemplate[] = [
  {
    id: "sunday-service",
    title: "Sunday service",
    category: "Service",
    hint: "The three slides almost every service needs: a welcome, the notices, the giving details",
    sections: [
      slide("Welcome", [
        title("Welcome home"),
        statement("We are glad you are here"),
      ]),
      slide("What's coming up", [
        title("This week"),
        {
          kind: "list",
          ordered: false,
          items: [
            { heading: "Midweek service", text: "Wednesday · 6:00 PM" },
            { heading: "Prayer meeting", text: "Tuesday · 6:00 AM" },
            { heading: "Youth night", text: "Friday · 5:30 PM" },
            { heading: "Baptism class", text: "Saturday · 10:00 AM" },
          ],
        },
      ]),
      slide("Giving", [
        title("Giving"),
        body("Account name · Your church"),
        body("0000000000 · Your bank"),
        body("Thank you for giving"),
      ]),
    ],
  },
  {
    id: "welcome",
    title: "Welcome",
    category: "Service",
    hint: "One card for the top of a service, or for the screen before it starts",
    sections: [
      slide("Welcome", [
        title("Welcome"),
        statement("We are glad you are here this morning"),
      ]),
    ],
  },
  {
    id: "notices",
    title: "Notices",
    category: "Announcement",
    hint: "This week, and where to go next — two slides to read out at the end",
    sections: [
      slide("This week", [
        title("This week"),
        {
          kind: "list",
          ordered: false,
          items: [
            { heading: "Midweek service", text: "Wednesday · 6:00 PM" },
            { heading: "Prayer meeting", text: "Tuesday · 6:00 AM" },
            { heading: "Choir practice", text: "Thursday · 5:00 PM" },
          ],
        },
      ]),
      slide("Stay in touch", [
        title("Stay in touch"),
        statement("Speak to someone at the welcome desk on your way out"),
      ]),
    ],
  },
  {
    id: "giving",
    title: "Giving details",
    category: "Giving",
    hint: "Account details on their own, for the offering",
    sections: [
      slide("Giving", [
        title("Giving"),
        body("Account name · Your church"),
        body("Account number · 0000000000"),
        body("Bank · Your bank"),
        body("Thank you for giving"),
      ]),
    ],
  },
  {
    id: "sermon-title",
    title: "Sermon title",
    category: "Sermon",
    hint: "A title card, and the passage the message is from",
    sections: [
      // Title and nothing under it: the renderer calls this a section marker
      // and sets it as large as the screen allows, which is what a title card
      // is for.
      slide("Title", [title("Today's message")]),
      slide("Passage", [
        title("Our reading"),
        // The reference, not the words. A passage component is read from the
        // verse library at the moment it goes up, so it is in the church's own
        // translation and cannot be a misquotation we shipped.
        { kind: "passage", reference: "Romans 8:28" },
      ]),
    ],
  },
  {
    id: "verse-card",
    title: "Verse card",
    category: "Scripture",
    hint: "One verse, set large — for a memory verse or a theme for the year",
    sections: [
      slide("Verse", [{ kind: "passage", reference: "Psalm 23:1" }]),
    ],
  },
  {
    id: "communion",
    title: "Communion",
    category: "Sacrament",
    hint: "A marker and the words of institution, for the table",
    sections: [
      slide("The table", [title("The Lord's table")]),
      slide("The words", [
        {
          kind: "quote",
          text: "This is my body, which is given for you: this do in remembrance of me.",
          attribution: "Luke 22:19",
        },
      ]),
    ],
  },
];

/** How a template's card describes itself: "3 slides · Service". */
export function describeTemplate(template: DeckTemplate): string {
  const count = template.sections.length;
  return `${count} ${count === 1 ? "slide" : "slides"} · ${template.category}`;
}
