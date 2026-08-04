import { useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const EVENT_INDEX = "semantic:status";

export interface IndexStatus {
  translation: string;
  /** disabled | building | ready | error */
  state: "disabled" | "building" | "ready" | "error";
  done: number;
  total: number;
  error: string | null;
}

/**
 * Progress of the local embedding index.
 *
 * Building it takes a couple of minutes per translation, once. The operator
 * needs to see that happening rather than wonder why paraphrase matching is
 * quiet.
 */
export function useSemanticIndex() {
  const [index, setIndex] = useState<IndexStatus>({
    translation: "",
    state: "disabled",
    done: 0,
    total: 0,
    error: null,
  });

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    void invoke<IndexStatus>("semantic_status")
      .then((status) => active && setIndex(status))
      .catch(() => undefined);

    void listen<IndexStatus>(EVENT_INDEX, (event) => {
      if (active) setIndex(event.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return index;
}
