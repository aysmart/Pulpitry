import { Fragment } from "react";

import type { VerseRun } from "../lib/projector";

/**
 * Words with their verse numbers raised.
 *
 * # Why every surface draws through this
 *
 * The wall raised its verse numbers and nothing else did: the operator's Live
 * and Preview panes, the stage display, the shipped lower thirds and the
 * shapes a church drew were each handed a flattened string, so "16 For God so
 * loved the world" began with a sixteen that read as part of the sentence.
 * That is the one thing a number in a passage must not do, and it meant the
 * desk disagreed with the screen it was previewing.
 *
 * So the raising happens once, here, and the size is relative -- half the
 * surrounding type, whatever that is -- so the same component is right in a
 * thumbnail, in a band over a camera and on a wall at four metres.
 *
 * # Nothing is drawn where there is no number
 *
 * A lone verse is never numbered (its reference is underneath it), and a
 * chorus has no numbers at all. Both arrive here as runs with `number: null`
 * and come out as plain words, which is why one component serves a reading, a
 * song and a notice.
 */
export function VerseRuns({ runs }: { runs: VerseRun[] }) {
  return (
    <>
      {runs.map((run, index) => (
        <Fragment key={index}>
          {run.number !== null ? (
            <sup className="mr-[0.25em] align-super text-[0.5em] opacity-55">
              {run.number}
            </sup>
          ) : null}
          {run.text}
          {/* The space the flattened string used to carry between verses.
              Inside the fragment rather than appended to the text, so the
              last run does not end in one. */}
          {index < runs.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}
