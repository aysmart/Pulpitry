import { useCallback, useState } from "react";

import { presentableLabel, type Presentable } from "./usePresentation";

/**
 * Passages put aside to come back to, during this service.
 *
 * # Why this is not the running order
 *
 * It was. The scripture desk's Queue and the Plan desk's running order were one
 * list, on the argument that putting a verse aside and putting it in the plan
 * are the same act. They are not, and the difference shows up in the one place
 * it matters:
 *
 * - **The plan** is what the service is going to do. It is written days before,
 *   by somebody who may not be the person running the desk, it holds things
 *   that never reach a screen, and it survives the app closing because next
 *   Sunday needs it.
 * - **This** is what the operator noticed ninety seconds ago. A preacher says
 *   "we'll come back to that" and it goes here. It is worth nothing on Tuesday.
 *
 * Sharing one list meant the second silently rewrote the first: a preacher
 * doubling back three times during a sermon left three verses in Sunday's
 * running order, and the plan somebody prepared on Friday was no longer the
 * plan. Whoever opened it next had to work out which lines were theirs.
 *
 * # Why it is not saved anywhere
 *
 * It expires. It is the same lifetime as the session history it sits beside --
 * both answer questions about the hour in progress and neither means anything
 * after it. Writing it to the catalogue would make a second thing to tidy up,
 * and an operator would find last week's asides waiting for them.
 */
export interface Aside {
  items: Presentable[];
  /** Puts something by. Already there is not an error, it is a no-op. */
  add: (item: Presentable) => void;
  removeAt: (index: number) => void;
  clear: () => void;
}

export function useAside(): Aside {
  const [items, setItems] = useState<Presentable[]>([]);

  const add = useCallback((item: Presentable) => {
    setItems((current) =>
      /*
       * Matched on the label rather than by identity.
       *
       * Two verses staged separately are two objects, and what the operator
       * sees is the reference: a list with "John 3:16" in it twice reads as a
       * mistake in the list rather than as two intentions. It is the same
       * weak match the running order uses to mark what is live, and the cost
       * of it being wrong is the same -- nothing acts on it.
       */
      current.some(
        (held) => presentableLabel(held) === presentableLabel(item),
      )
        ? current
        : [...current, item],
    );
  }, []);

  const removeAt = useCallback((index: number) => {
    setItems((current) => current.filter((_, at) => at !== index));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  return { items, add, removeAt, clear };
}
