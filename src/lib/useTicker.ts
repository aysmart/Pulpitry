import { useCallback, useEffect, useState } from "react";

import { getTicker, onTicker, setTicker, type Ticker } from "./projector";

const OFF: Ticker = {
  text: "",
  visible: false,
  textColor: "#F4F1EA",
  bandColor: "#000000",
  bandOpacity: 0.45,
  position: "bottom",
  speed: 24,
};

/**
 * The announcement band.
 *
 * Held in Rust like the live content, so the operator's pane shows exactly
 * what the congregation is reading.
 */
export function useTicker() {
  const [ticker, setState] = useState<Ticker>(OFF);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void getTicker().then((current) => active && setState(current)).catch(() => undefined);
    void onTicker((next) => active && setState(next)).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const change = useCallback((next: Partial<Ticker>) => {
    setState((current) => {
      const merged = { ...current, ...next };
      void setTicker(merged).catch(() => undefined);
      return merged;
    });
  }, []);

  return { ticker, change };
}
