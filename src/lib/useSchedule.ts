import { useCallback, useEffect, useRef, useState } from "react";

import { catalogList, catalogRemove, catalogSave, type Item, type PlanEntry } from "./catalog";
import { defaultServiceName, entryFor, labelFor, resolveEntry } from "./schedule";
import type { Presentable } from "./usePresentation";

/** How long after the last edit the plan is written back. */
const SAVE_DELAY = 600;

/** Longer than any service. A plan is a running order, not an archive. */
const MAX_ENTRIES = 300;

/** Everything the Schedule tab needs, passed around as one prop. */
export type ScheduleController = ReturnType<typeof useSchedule>;

export interface ScheduleState {
  /** Every saved service, most recently touched first. */
  services: Item[];
  /** The one being edited, if any. */
  openId: number | null;
  name: string;
  entries: PlanEntry[];
  saving: boolean;
}

/**
 * The service plan: what this gathering will do, in order.
 *
 * Unlike everything else in the operator window this outlives the session, so
 * it lives in the library rather than in React state. Edits are written back a
 * moment after they stop, which means a crash mid-service costs nothing —
 * the reason for building this at all.
 *
 * Entries hold references, so a plan made on Tuesday still points at the right
 * things on Sunday even if the song was edited in between.
 */
export function useSchedule(onError?: (message: string) => void) {
  const [services, setServices] = useState<Item[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [entries, setEntries] = useState<PlanEntry[]>([]);
  const [saving, setSaving] = useState(false);

  // Only operator edits are worth writing back. Without this, opening a plan
  // would immediately save it again and reshuffle the most-recent ordering.
  const dirty = useRef(false);
  const fail = useRef(onError);
  fail.current = onError;

  const report = useCallback((err: unknown) => {
    fail.current?.(err instanceof Error ? err.message : String(err));
  }, []);

  // Reopen whatever was last worked on. An operator who set up Sunday's plan
  // on Saturday expects to find it there, not an empty list.
  useEffect(() => {
    let active = true;
    void catalogList("service", 100)
      .then((found) => {
        if (!active) return;
        setServices(found);
        const latest = found[0];
        if (!latest || latest.body.kind !== "service") return;
        setOpenId(latest.id);
        setName(latest.title);
        setEntries(latest.body.entries);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [report]);

  const persist = useCallback(
    async (id: number, title: string, list: PlanEntry[]) => {
      setSaving(true);
      try {
        const saved = await catalogSave({
          id,
          title: title.trim() || defaultServiceName(),
          subtitle: "",
          body: { kind: "service", entries: list },
          path: null,
          updatedAt: 0,
        });
        setServices((current) => [
          saved,
          ...current.filter((service) => service.id !== saved.id),
        ]);
      } catch (err) {
        report(err);
      } finally {
        setSaving(false);
      }
    },
    [report],
  );

  // What flush should write. Held in a ref so flush keeps one identity rather
  // than being rebuilt on every keystroke.
  const pending = useRef({ openId, name, entries });
  pending.current = { openId, name, entries };

  /**
   * Writes the plan out now.
   *
   * Called before anything that switches away from it: a debounce that a
   * service change can outrun would lose the edit that prompted it.
   */
  const flush = useCallback(async () => {
    const { openId: id, name: title, entries: list } = pending.current;
    if (!dirty.current || id === null) return;
    dirty.current = false;
    await persist(id, title, list);
  }, [persist]);

  // Write back shortly after the edits stop, rather than on every keystroke.
  useEffect(() => {
    if (!dirty.current || openId === null) return;
    const timer = setTimeout(() => void flush(), SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [openId, name, entries, flush]);

  const edit = useCallback((next: (current: PlanEntry[]) => PlanEntry[]) => {
    dirty.current = true;
    setEntries(next);
  }, []);

  /**
   * Starts a plan. Returns its id so a caller mid-flow can carry on with it,
   * since the state update will not have landed yet.
   */
  const create = useCallback(
    async (title?: string): Promise<number | null> => {
      await flush();
      try {
        const saved = await catalogSave({
          id: null,
          title: title?.trim() || defaultServiceName(),
          subtitle: "",
          body: { kind: "service", entries: [] },
          path: null,
          updatedAt: 0,
        });
        dirty.current = false;
        setServices((current) => [saved, ...current]);
        setOpenId(saved.id);
        setName(saved.title);
        setEntries([]);
        return saved.id;
      } catch (err) {
        report(err);
        return null;
      }
    },
    [flush, report],
  );

  const open = useCallback(
    async (id: number) => {
      await flush();
      const service = services.find((candidate) => candidate.id === id);
      if (!service || service.body.kind !== "service") return;
      dirty.current = false;
      setOpenId(id);
      setName(service.title);
      setEntries(service.body.entries);
    },
    [services, flush],
  );

  const rename = useCallback((title: string) => {
    dirty.current = true;
    setName(title);
  }, []);

  const remove = useCallback(
    async (id: number) => {
      try {
        await catalogRemove(id);
        const left = services.filter((service) => service.id !== id);
        setServices(left);
        if (openId !== id) return;
        // Fall back to whatever is next rather than leaving nothing open.
        dirty.current = false;
        const next = left[0];
        if (next && next.body.kind === "service") {
          setOpenId(next.id);
          setName(next.title);
          setEntries(next.body.entries);
        } else {
          setOpenId(null);
          setName("");
          setEntries([]);
        }
      } catch (err) {
        report(err);
      }
    },
    [services, openId, report],
  );

  /**
   * Appends a line, starting a plan first if none is open.
   *
   * Duplicates are allowed on purpose: a song reprised after the sermon is a
   * second line of the running order, not a mistake.
   */
  const append = useCallback(
    async (entry: PlanEntry) => {
      if (openId === null && (await create()) === null) return;
      edit((current) => [...current, entry].slice(0, MAX_ENTRIES));
    },
    [openId, create, edit],
  );

  const add = useCallback(
    (item: Presentable) => void append(entryFor(item)),
    [append],
  );

  const addNote = useCallback(
    (label: string) => void append({ label, body: { kind: "note" } }),
    [append],
  );

  const removeAt = useCallback(
    (index: number) => edit((current) => current.filter((_, at) => at !== index)),
    [edit],
  );

  const move = useCallback(
    (index: number, delta: number) =>
      edit((current) => {
        const target = index + delta;
        if (target < 0 || target >= current.length) return current;
        const next = [...current];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved!);
        return next;
      }),
    [edit],
  );

  const relabel = useCallback(
    (index: number, label: string) =>
      edit((current) =>
        current.map((entry, at) => (at === index ? { ...entry, label } : entry)),
      ),
    [edit],
  );

  /**
   * Stages a line. Corrects the stored label on the way past, so a song
   * renamed since the plan was written stops reading under its old name.
   */
  const stage = useCallback(
    async (index: number): Promise<Presentable | null> => {
      const entry = entries[index];
      if (!entry) return null;
      try {
        const [staged, current] = await Promise.all([resolveEntry(entry), labelFor(entry)]);
        if (current && current !== entry.label) relabel(index, current);
        return staged;
      } catch (err) {
        report(err);
        return null;
      }
    },
    [entries, relabel, report],
  );

  return {
    services,
    openId,
    name,
    entries,
    saving,
    create,
    open,
    rename,
    remove,
    add,
    addNote,
    removeAt,
    move,
    relabel,
    stage,
  };
}
