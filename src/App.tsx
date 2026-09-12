import { useCallback, useEffect, useState, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { AboutDialog } from "./components/AboutDialog";
import { HistoryDialog } from "./components/HistoryDialog";
import { DeckStrip } from "./components/DeckStrip";
import { Detections } from "./components/Detections";
import { OriginalPanel } from "./components/OriginalPanel";
import { Panel, PanelCount } from "./components/Panel";
import { QueueRail } from "./components/QueueRail";
import { ImportPreview } from "./components/ImportPreview";
import { ScriptureFeed } from "./components/ScriptureFeed";
import { SectionsPanel } from "./components/SectionsPanel";
import { SongFinderPanel } from "./components/SongFinderPanel";
import { ScripturePanel } from "./components/ScripturePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { OutputsDialog } from "./components/OutputsDialog";
import { useFollow } from "./lib/useFollow";
import { catalogGet } from "./lib/catalog";
import { rememberLines, sameScreen, type LinesPerScreen } from "./lib/lyrics";
import { presentableFor } from "./lib/schedule";
import type { SongFinderHit } from "./lib/songfinder";
import { SlidesFromSermon } from "./components/SlidesFromSermon";
import { TemplateLibrary } from "./components/TemplateLibrary";
import {
  MainOutput,
  PreviewPanel,
  StagePanel,
} from "./components/StagePanel";
import { TopBar } from "./components/TopBar";
import { TranscriptPanel } from "./components/TranscriptPanel";
import type { Tab } from "./components/ScripturePanel";
import {
  rememberWorkspace,
  storedWorkspace,
  WORKSPACES,
  WORKSPACE_ORDER,
  type Workspace,
} from "./lib/workspaces";
import {
  describeError,
  getSettings,
  listAudioInputs,
  saveSettings,
  startTranscription,
  stopTranscription,
  type AudioDevice,
  type SettingsView,
} from "./lib/api";
import {
  lexiconEntry,
  libraryStatus,
  onLibraryStatus,
  type LexiconEntry,
  type LibraryStatus,
  type Verse,
} from "./lib/bible";
import {
  getStage,
  setStage,
  closeProjector,
  openProjector,
  openSecond,
  closeSecond,
  secondState,
  projectorState,
  bodyText,
  type ProjectorState,
  type SecondState,
} from "./lib/projector";
import { exportTranscript } from "./lib/exportTranscript";
import { DEFAULT_THEME } from "./lib/theme";
import { useDetections } from "./lib/useDetections";
import { usePresentation } from "./lib/usePresentation";
import { useUpdate } from "./lib/useUpdate";
import { useAudio } from "./lib/useAudio";
import { useMedia } from "./lib/useMedia";
import { useSchedule } from "./lib/useSchedule";
import { useTicker } from "./lib/useTicker";
import { useSemanticIndex } from "./lib/useSemanticIndex";
import { useSpokenReferences } from "./lib/useSpokenReferences";
import { useSuggestions } from "./lib/useSuggestions";
import { useTranscript } from "./lib/useTranscript";

/**
 * Whether the chosen engine has what it needs to start.
 *
 * Each wants something different: this machine a model that has been
 * downloaded, a subscription an activated licence. Nothing here checks that
 * they are *correct* -- only that the operator has been asked.
 */
/** An instruction the operator spoke, as the Rust side reports it. */
interface VoiceCommand {
  action: string;
  translation?: string;
  /** Null for a reference within the book being read. */
  book?: string | null;
  /** Null for "verse nine" said on its own, which keeps the chapter open. */
  chapter?: number | null;
  /** A relative chapter move: 1 for "next chapter", -1 for "previous". */
  by?: number;
  verse?: number | null;
  /** An absolute slide, counted from one as a person counts. */
  to?: number | null;
}

/**
 * What a desk looks like before anybody has chosen anything.
 *
 * The wall's look, with one change: a song desk does not caption its words.
 *
 * The line under the words is a reference under a verse and a *title* under a
 * chorus, and only the first is information. Somebody reading a passage is
 * finding it in their own Bible; nobody singing needs to be told which song
 * they are singing, and on a wall it reads as a caption on a photograph. It is
 * a switch rather than a rule -- a church that wants their set list on screen
 * turns it on -- but the default should be the thing most churches want.
 */
function deskDefault(
  desk: Workspace,
  wall: typeof DEFAULT_THEME,
): typeof DEFAULT_THEME {
  return desk === "songs" ? { ...wall, showReference: false } : wall;
}

/**
 * The desks that have a look of their own.
 *
 * Everything but the slide desk, which draws each deck against the background
 * it was laid out on. Derived rather than listed, so an arrangement added later
 * is included by being added rather than by somebody remembering this.
 */
const LOOK_DESKS: Workspace[] = WORKSPACE_ORDER.filter(
  (desk) => WORKSPACES[desk].frame !== "deck",
);

function ready(settings: SettingsView | null): boolean {
  if (!settings) return false;
  switch (settings.speechEngine) {
    case "local":
      return settings.speechModel.trim().length > 0;
    default:
      // Two engines, and the subscription is the only one with anything to
      // check. Anything unrecognised -- an installation still holding the
      // withdrawn Azure engine -- reads as hosted's neighbour rather than as a
      // third thing, and `settings.rs` has already moved it to local by the
      // time this runs.
      return settings.hasHostedSubscription;
  }
}

export default function App() {
  const { lines, interim, status, clear } = useTranscript();
  /*
   * How the desk is arranged, and which library is in front.
   *
   * One state rather than two: choosing Songs on the desk has to bring the
   * song library forward, or the arrangement would give the width to something
   * the operator is not looking at. Pressing a tab moves the library alone,
   * which is the finer adjustment and still allowed.
   */
  const [workspace, setWorkspace] = useState<Workspace>(storedWorkspace);
  const [tab, setTab] = useState<Tab>(WORKSPACES[storedWorkspace()].tabs[0]);
  const shape = WORKSPACES[workspace];
  /*
   * The library in front, kept inside what this arrangement offers.
   *
   * Switching to Slides while the Scripture chapter was open would otherwise
   * ask the panel for a tab it is no longer drawing, and it would show
   * nothing at all.
   */
  const shownTab = shape.tabs.includes(tab) ? tab : shape.tabs[0];
  const chooseWorkspace = useCallback((next: Workspace) => {
    setWorkspace(next);
    setTab(WORKSPACES[next].tabs[0]);
    rememberWorkspace(next);
  }, []);
  const {
    preview,
    live,
    liveKey,
    liveDesk,
    history,
    clearHistory,
    previewVerse,
    previewVerses,
    previewItem,
    showVerse,
    showVerses,
    showItem,
    keyOf,
    display,
    clearLive,
    goToPassage,
    goToSlide,
    retranslate,
    wind,
    step,
    canStepBack,
    canStepForward,
  } = usePresentation(workspace);
  /*
   * The verse the Original panel is showing, held rather than derived.
   *
   * It used to read `preview`, which erased itself: clicking a word stages that
   * word, `preview` stops being scripture, and the panel that produced the word
   * emptied on the click. The operator lost the verse by using it.
   *
   * So it follows scripture and ignores everything else. Staging a word, a
   * song or a slide leaves it alone; staging a different verse moves it.
   */
  const [originalVerse, setOriginalVerse] = useState<Verse | null>(null);

  /*
   * The lexicon entry the operator last opened, held here rather than in the
   * panel that opens it: the Original panel raises the question and the library
   * tab answers it, so neither owns the answer.
   *
   * `lexiconAt` is a timestamp rather than a flag so that opening the same word
   * twice still counts as an event, and the library still switches to it.
   */
  const [lexicon, setLexicon] = useState<LexiconEntry | null>(null);
  const [lexiconLooking, setLexiconLooking] = useState(false);
  const [lexiconAt, setLexiconAt] = useState(0);

  const openLexicon = useCallback((strongs: string) => {
    if (!strongs) return;
    setLexiconLooking(true);
    setLexiconAt(Date.now());
    void lexiconEntry(strongs)
      .then(setLexicon)
      .catch(() => setLexicon(null))
      .finally(() => setLexiconLooking(false));
  }, []);

  useEffect(() => {
    if (preview?.kind !== "scripture") return;
    const first = preview.verses[0] ?? null;
    // Compared by id rather than by object: staging the same verse again --
    // stepping through a passage, re-showing it -- should not re-query.
    setOriginalVerse((current) =>
      current?.id === first?.id ? current : first,
    );
  }, [preview]);

  const { detections, clear: clearDetections } = useDetections();
  const { suggestions, clear: clearSuggestions } = useSuggestions();
  const { references, clear: clearReferences } = useSpokenReferences();

  /*
   * Empties the Detected panel.
   *
   * All three sources, because the panel shows one list and an operator
   * pressing Clear on it means the list -- leaving announced references behind
   * while quotations vanished would read as a fault rather than a filter.
   */
  const clearHeard = useCallback(() => {
    clearDetections();
    clearSuggestions();
    clearReferences();
  }, [clearDetections, clearSuggestions, clearReferences]);
  const semanticIndex = useSemanticIndex();

  const [settings, setSettings] = useState<SettingsView | null>(null);

  /*
   * An announced reference goes live on its own, where the operator asked.
   *
   * Only the announced kind. The three lists are three different claims and
   * this is the only one where nothing was inferred: the speaker said where
   * they were going -- "turn with me to John 3:16" -- so there is no guess to
   * be wrong about. A text match can be the speaker quoting a different verse
   * in passing, and a paraphrase match is weaker still; both stay in the list
   * for a click, which is what a click is for.
   *
   * Our terms say nothing should reach a congregation without somebody
   * deciding it should, and that still holds: the deciding is switching this
   * on, once, for a service where the preacher announces their passages.
   *
   * Only the newest, and never twice. A reference arriving mid-reading must
   * not pull the screen off the verse being read, so the id is remembered
   * rather than the object -- the list is rebuilt on every event.
   */
  const autoLive = settings?.verseDisplay === "auto";
  const announced = references[0]?.verse;
  const shownId = useRef<number | null>(null);

  useEffect(() => {
    if (!autoLive || !announced) return;
    if (shownId.current === announced.id) return;
    shownId.current = announced.id;
    showVerse(announced);
  }, [autoLive, announced, showVerse]);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [library, setLibrary] = useState<LibraryStatus>({
    ready: false,
    translations: [],
    importing: null,
    error: null,
  });
  const [translation, setTranslation] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * The looks screen, opened from the top bar.
   *
   * Not from a tab: it was one on the song desk and nowhere at all on the
   * scripture desk, which has a single library and therefore no tab strip to
   * hang it from. A look belongs to the desk rather than to a library, so it
   * is reached the way the desk's other belongings are.
   */
  const [looksOpen, setLooksOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [slidesOpen, setSlidesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * A newer version, checked once when the window opens.
   *
   * Never on a timer and never while a service is running: a check costs
   * nothing but a download does, and an application that decided to update
   * itself mid-sermon would be worse than one that is out of date.
   *
   * `settings` is null for the first moments of a launch, which reads as off --
   * so a church that turned this off is never asked, and everybody else is
   * asked a moment later when settings arrive.
   */
  const update = useUpdate(settings?.updateCheck ?? false);

  /**
   * The look this desk works in.
   *
   * Each desk has its own — a verse and a lyric are different kinds of reading
   * and a church may well set them differently — and a desk that has never
   * chosen one falls back to the wall's, which is what every installation
   * before this had.
   *
   * The slide desk is not given one on purpose: a deck carries its own
   * background and its slides are laid out against it, so a look over the top
   * would be a second answer to a question the deck has already answered.
   */
  const look =
    settings?.deskLooks?.[workspace] ??
    deskDefault(workspace, settings?.projector ?? DEFAULT_THEME);

  const [error, setError] = useState<string | null>(null);
  const [projector, setProjector] = useState<ProjectorState>({
    open: false,
    display: null,
  });
  const [second, setSecond] = useState<SecondState>({
    open: false,
    display: null,
  });

  // The running order. Kept in the library rather than in state, so closing
  // the app mid-service does not cost the plan.
  const schedule = useSchedule(setError);
  /*
   * The songs for this service, which is a different list from the plan.
   *
   * Its own rows, not a filtered view of the plan: two people build these,
   * usually on different days, and sharing one list meant the worship leader
   * reordering their songs reordered the service and the person planning the
   * service could delete a song out from under the band.
   */
  const songSet = useSchedule(setError, "songSet");
  const { audio, change: changeAudio } = useAudio();
  const media = useMedia();
  const { ticker, change: changeTicker } = useTicker();

  const stageEntry = useCallback(
    async (index: number, andShow?: boolean) => {
      const staged = await schedule.stage(index);
      if (!staged) return staged;
      previewItem(staged);
      // The same rule as every list: one click stages, two puts it up. The
      // item is passed on rather than read back from `preview`, which has not
      // re-rendered yet.
      if (andShow) showItem(staged);
      return staged;
    },
    [schedule, previewItem, showItem],
  );

  /**
   * Taking an entry out of the running order, from wherever it is shown.
   *
   * Written once because three lists now show the same queue — the rail, the
   * scripture feed and the plan — and three copies of the staging rule would be
   * three chances to get it wrong.
   */
  const stageFromQueue = useCallback(
    (index: number, andShow?: boolean) => {
      void stageEntry(index, andShow);
    },
    [stageEntry],
  );

  /**
   * A part of what is staged: a slide of a deck, a verse or chorus of a song.
   *
   * One click stages, two puts it up -- the rule every list in this window
   * follows. Built from the staged item rather than through `goToSlide`, which
   * keeps whatever was live live: right for a spoken instruction, wrong for a
   * click somebody may have meant as a look.
   */
  const chooseSection = useCallback(
    (index: number, andShow?: boolean) => {
      if (preview?.kind !== "lyric") return;
      const part = { ...preview, index };
      if (andShow) showItem(part);
      else previewItem(part);
    },
    [preview, showItem, previewItem],
  );

  /**
   * Taking a song out of the set, which follows the plan's own rule on the
   * other list: one click stages, two puts it up, and what goes on the screen
   * is the item that came back rather than whatever `preview` holds this
   * render.
   */
  const stageFromSet = useCallback(
    (index: number, andShow?: boolean) => {
      void songSet.stage(index).then((staged) => {
        if (!staged) return;
        previewItem(staged);
        if (andShow) showItem(staged);
      });
    },
    [songSet, previewItem, showItem],
  );

  /**
   * Changing how many lines a screen holds, mid-song.
   *
   * The staged item carries the *split*, so re-splitting it would label a
   * continuation as a continuation of a continuation. The song is fetched
   * again instead -- one round trip on a rare action -- and the operator is
   * put back on the screenful they were on, matched by its first line.
   */
  const changeLines = useCallback(
    (lines: LinesPerScreen) => {
      rememberLines(lines);
      if (preview?.kind !== "lyric" || !preview.songId) {
        // Nothing staged to re-break; the next song staged takes the new value.
        setNotice(`Songs will show ${lines === 0 ? "whole sections" : `${lines} lines`} at a time.`);
        return;
      }

      const wasOn = preview.sections[preview.index]?.lines[0];
      void catalogGet(preview.songId)
        .then((item) => {
          if (!item) return;
          const staged = presentableFor(item);
          if (staged?.kind !== "lyric") return;
          previewItem({
            ...staged,
            index: sameScreen(staged.sections, wasOn),
          });
        })
        .catch((err) => setError(describeError(err)));
    },
    [preview, previewItem],
  );

  /** The AI Song Finder entry being looked at, before it is added to the library. */
  const [found, setSongFinderHit] = useState<SongFinderHit | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([getSettings(), listAudioInputs()])
      .then(([loaded, inputs]) => {
        if (!active) return;
        setSettings(loaded);
        setDevices(inputs);
      })
      .catch((err) => active && setError(describeError(err)));
    return () => {
      active = false;
    };
  }, []);

  // The library import runs in the background on first launch, so take the
  // current state now and keep listening for it to finish.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    const apply = (next: LibraryStatus) => {
      if (!active) return;
      setLibrary(next);
    };

    void libraryStatus()
      .then(apply)
      .catch(() => undefined);
    void onLibraryStatus(apply).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Settings and the library arrive independently, so reconcile once both
  // are here. Defaulting to the first translation would quietly disagree with
  // the backend, which detects against whatever was saved.
  useEffect(() => {
    if (!settings || library.translations.length === 0) return;
    const available = (id: string) =>
      library.translations.some((entry) => entry.id === id);
    setTranslation((current) => {
      if (current && available(current)) return current;
      if (settings.translation && available(settings.translation))
        return settings.translation;
      return library.translations[0]?.id ?? "";
    });
  }, [settings, library.translations]);

  // Displays get plugged in after the app is already open, so refresh the
  // list whenever the operator goes looking rather than only at launch.
  const refreshDisplays = useCallback(async () => {
    try {
      const [state, onSecond] = await Promise.all([
        projectorState(),
        secondState(),
      ]);
      setProjector(state);
      setSecond(onSecond);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refreshDisplays();
  }, [refreshDisplays]);

  /*
   * The second display, kept independent of the projector.
   *
   * A church may want one, the other, or both, and the second belongs on a
   * screen the first is not using. Tying them together would be deciding for
   * them.
   */
  const toggleSecond = useCallback(
    async (display?: number) => {
      setError(null);
      try {
        setSecond(
          second.open && display === undefined
            ? await closeSecond()
            : await openSecond(display),
        );
      } catch (err) {
        setError(describeError(err));
      }
    },
    [second.open],
  );

  const toggleProjector = useCallback(
    async (display?: number) => {
      setError(null);
      try {
        setProjector(
          projector.open && display === undefined
            ? await closeProjector()
            : await openProjector(display),
        );
        void refreshDisplays();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [projector.open, refreshDisplays],
  );

  const active =
    status.state === "listening" ||
    status.state === "starting" ||
    status.state === "reconnecting";

  const toggleListening = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (active) {
        await stopTranscription();
      } else {
        // Nothing can start without whatever the chosen engine needs, so send
        // the operator straight to the place that fixes it rather than
        // reporting a failure.
        //
        // What counts as ready depends on the engine. It once asked everybody
        // for an Azure key, which sent anyone transcribing on this machine to
        // Settings to enter a key they had rightly never bought.
        if (!ready(settings)) {
          setSettingsOpen(true);
          return;
        }
        await startTranscription();
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [active, settings]);

  // Detection searches whichever translation is selected, and the Rust side
  // reads it from settings, so the choice has to be persisted rather than kept
  // in component state.
  const selectTranslation = useCallback(
    (id: string) => {
      setTranslation(id);
      // What is staged follows the choice. Changing translation during a
      // service means "this verse, in that wording" -- it is the only reason
      // to change one mid-reading -- and this is the same whether the operator
      // used the dropdown or said it out loud.
      void retranslate(id);
      if (!settings || settings.translation === id) return;
      void saveSettings({ ...settings, translation: id })
        .then(setSettings)
        .catch((err) => setError(describeError(err)));
    },
    [settings, retranslate],
  );

  /**
   * Applies a whole look at once.
   *
   * Saved rather than held locally: the projector window reads the theme from
   * settings, so a template that only changed this window would leave the two
   * disagreeing about what the congregation is looking at.
   */
  const applyTheme = useCallback(
    (chosen: typeof DEFAULT_THEME) => {
      if (!settings) return;

      /*
       * Choosing here must not move any other desk, and it did.
       *
       * A desk with no look of its own falls back to the wall's, which is the
       * right answer on a fresh installation -- all four start alike. But
       * applying a look on the song desk also set the wall's, so the scripture
       * desk, which had never chosen one, followed it. Two desks, one look,
       * and no way to tell they were not separate.
       *
       * So the first time any desk is given a look, every other desk is written
       * with the one it was already wearing. From then on each is explicit and
       * none of them can drag another along. It happens once, invisibly, and
       * the alternative -- seeding all four at startup -- would write settings
       * on a machine where nobody has asked for anything.
       */
      const kept = { ...(settings.deskLooks ?? {}) };
      for (const desk of LOOK_DESKS) {
        // The same default each desk was already drawing with, so seeding
        // changes nothing an operator can see.
        if (!kept[desk]) kept[desk] = deskDefault(desk, settings.projector);
      }
      kept[workspace] = chosen;

      /*
       * The wall follows too, but only when this desk is the one on it.
       *
       * Changing the look of the desk you are working at while its verse is on
       * the wall should change the wall -- that is what "apply" means to the
       * person pressing it. Changing it while another desk owns the wall
       * changes what you are preparing and leaves the congregation alone.
       */
      const owns = liveDesk === null || liveDesk === workspace;
      void saveSettings({
        ...settings,
        deskLooks: kept,
        projector: owns ? chosen : settings.projector,
      })
        .then(setSettings)
        .catch((err) => setError(describeError(err)));
    },
    [settings, workspace, liveDesk],
  );

  /*
   * The wall wears the look of whichever desk put something on it.
   *
   * Compared before writing, because settings are a file: consecutive slides
   * from one desk must not each cost a write, and only actually changing desks
   * does. Keys are sorted first -- a plain stringify would depend on Rust and
   * TypeScript declaring the fields in the same order.
   */
  useEffect(() => {
    if (!settings || liveDesk === null) return;
    /*
     * The desk's default counts as its look.
     *
     * Reading only the stored ones meant a song going live before anybody had
     * opened the looks screen left the wall exactly as it was -- titles under
     * the words included -- while the desk's own preview showed them gone. The
     * two disagreed about the same song.
     */
    const wanted =
      settings.deskLooks?.[liveDesk] ??
      deskDefault(liveDesk, settings.projector);

    const stable = (theme: typeof DEFAULT_THEME) =>
      JSON.stringify(Object.entries(theme).sort(([a], [b]) => a.localeCompare(b)));
    if (stable(wanted) === stable(settings.projector)) return;

    void saveSettings({ ...settings, projector: wanted })
      .then(setSettings)
      .catch((err) => setError(describeError(err)));
  }, [liveDesk, settings]);

  const selectDevice = useCallback(
    async (id: string | null) => {
      if (!settings) return;
      setSettings({ ...settings, inputDeviceId: id });
      try {
        setSettings(await saveSettings({ ...settings, inputDeviceId: id }));
        // The device is read when a session starts, so an in-progress session
        // has to be cycled for the change to take effect mid-service.
        if (active) {
          await stopTranscription();
          await startTranscription();
        }
      } catch (err) {
        setError(describeError(err));
      }
    },
    [settings, active],
  );

  // The confirmation is transient; the status bar belongs to the live session.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const saveTranscript = useCallback(async () => {
    setError(null);
    setExporting(true);
    try {
      const path = await exportTranscript(lines, {
        device: status.device,
        language: settings?.language,
      });
      // Cancelling the dialog is not a failure and needs no message.
      if (path) setNotice(`Transcript saved to ${path}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExporting(false);
    }
  }, [lines, status.device, settings]);

  // The supervisor's own detail line is more specific than anything we'd write.
  const footer =
    error ??
    notice ??
    status.detail ??
    library.error ??
    (library.importing ? `Installing ${library.importing}\u2026` : null) ??
    (semanticIndex.state === "building" && semanticIndex.total > 0
      ? `Preparing ${semanticIndex.translation} for paraphrase matching \u2014 ${Math.floor(
          (semanticIndex.done / semanticIndex.total) * 100,
        )}%`
      : null);

  /*
   * The menu bar, answered here.
   *
   * Every one of these has a button in the window that already knows the state
   * it changes -- whether the projector is open, whether the microphone is
   * running. Doing the work again from a menu handler would be a second
   * implementation of each, and the two would disagree the first time either
   * changed. So the menu chooses and this dispatches to what the buttons call.
   */
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;

    void listen<string>("menu:chose", (event) => {
      switch (event.payload) {
        case "about":
          setAboutOpen(true);
          break;
        case "settings":
          setSettingsOpen(true);
          break;
        case "history":
          setHistoryOpen(true);
          break;
        case "slides":
          setSlidesOpen(true);
          break;
        case "mirror":
          // The mirror lives inside Settings rather than in a dialog of its
          // own, so this opens the page it is on.
          setSettingsOpen(true);
          break;
        case "projector":
          void toggleProjector();
          break;
        case "second":
          void toggleSecond();
          break;
        case "listen":
          void toggleListening();
          break;
        case "clear":
          clearLive();
          break;
      }
    }).then((off) => {
      if (active) stop = off;
      else off();
    });

    return () => {
      active = false;
      stop?.();
    };
  }, [toggleProjector, toggleSecond, toggleListening, clearLive]);

  /*
   * Doing what the operator said.
   *
   * The Rust side decides what was heard and this end decides what it means,
   * because only this end knows what is staged. Deliberately the same actions
   * the keyboard already has: the value is an operator not having to look down,
   * not a spoken language for driving a projector.
   */
  /*
   * Registered once, and reached through a ref.
   *
   * Every action here reads what is currently staged, so a handler capturing
   * those values would have to be re-registered on every change -- and each
   * re-registration tears down a listener and adds another, which drops
   * whatever arrives in between. An instruction lost that way looks exactly
   * like the operator having to say it twice.
   */
  /*
   * Following the service, which is offered rather than done.
   *
   * The handler takes the suggestion only when the operator has asked it to;
   * otherwise the slide is shown as something they may press. Auto-advance is
   * a deliberate choice with a visible cost, and it should feel like one.
   */
  /*
   * What the platform is told is coming next.
   *
   * Worked out here because this is the only place that knows both the plan
   * and where it has got to. The stage window is sent a *label*, not the plan
   * -- keeping the congregation-facing window ignorant of the library is most
   * of why it can be trusted with a wall.
   *
   * Matched by label, the same rule the queue rail marks the live item with,
   * so the two cannot disagree about which entry the service is on.
   */
  const nextUp = (() => {
    const entries = schedule.entries;
    const caption = live?.caption ?? null;
    if (entries.length === 0 || !caption) return "";
    const at = entries.findIndex((entry) => entry.label === caption);
    // Not in the plan, or the last thing in it: either way there is nothing
    // to promise, and an empty line is more honest than a guess.
    if (at < 0 || at + 1 >= entries.length) return "";
    return entries[at + 1]?.label ?? "";
  })();

  /*
   * Pushed only when it changes.
   *
   * Every send reaches every window, and re-sending the same label on each
   * verse would be a message a second to say nothing new.
   */
  const sentNext = useRef<string | null>(null);
  useEffect(() => {
    if (sentNext.current === nextUp) return;
    sentNext.current = nextUp;
    void getStage()
      .then((held) => setStage({ ...held, nextUp }))
      .catch(() => undefined);
  }, [nextUp]);

  const follow = useFollow(preview, (found) => {
    if (found.advance) goToSlide(found.index + 1);
  });

  const onVoiceCommand = useRef<(payload: VoiceCommand) => void>(() => {});
  onVoiceCommand.current = (payload: VoiceCommand) => {
    switch (payload.action) {
      case "nextVerse":
        void step(true);
        break;
      case "previousVerse":
        void step(false);
        break;
      case "clear":
        clearLive();
        break;
      case "passage":
        // One shape for every way of asking. A null book is the one being
        // read, a null chapter the one already open, and `by` a relative move
        // -- so "next chapter verse nine" and "John nine eight" arrive here
        // the same way.
        void goToPassage({
          book: payload.book ?? null,
          chapter: payload.chapter ?? null,
          by: payload.by ?? 0,
          verse: payload.verse ?? null,
        });
        break;
      case "slide": {
        /*
         * A deck, not the running order.
         *
         * This moved through the *queue*, which was a misreading of what a
         * slide is here: a sermon's slides are kept as one item with sections,
         * so "next slide" said over a staged deck means its next section --
         * exactly what the Next button does. Jumping to the next thing in the
         * plan instead put an unrelated item on the screen.
         *
         * So it is `step`, which already knows how to walk a deck, and the
         * queue is left out of it entirely: nothing an operator says about
         * slides should reorder their service.
         */
        if (payload.to != null) {
          if (!goToSlide(payload.to)) {
            setNotice(
              preview?.kind === "lyric"
                ? `This deck has ${preview.sections.length} slides.`
                : "No deck is staged, so there is no slide to go to.",
            );
          }
          break;
        }

        if (preview?.kind !== "lyric") {
          setNotice("No deck is staged, so there is nothing to move through.");
          break;
        }
        void step((payload.by ?? 1) > 0);
        break;
      }
      case "switch":
        // A translation nobody has installed is ignored rather than
        // reported. The listener only ever names one that is in the
        // library, so this guards a race -- somebody removing it while the
        // words were in the air -- and is not worth interrupting a service
        // for.
        if (payload.translation) selectTranslation(payload.translation);
        break;
    }
  };

  useEffect(() => {
    let active = true;
    let stop: UnlistenFn | undefined;

    void listen<VoiceCommand>("voice-command", ({ payload }) =>
      onVoiceCommand.current(payload),
    ).then((off) => {
      if (active) stop = off;
      else off();
    });

    return () => {
      active = false;
      stop?.();
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-pulpitry-ink text-pulpitry-text">
      <TopBar
        status={status}
        devices={devices}
        selectedDeviceId={settings?.inputDeviceId ?? null}
        onSelectDevice={selectDevice}
        onToggleListening={() => void toggleListening()}
        onOpenSettings={() => setSettingsOpen(true)}
        busy={busy || !settings}
        onOpenOutputs={() => setOutputsOpen(true)}
        /* Absent on the slide desk, where a deck carries its own background
           and a look over the top would be a second answer. */
        onOpenLooks={shape.frame === "deck" ? null : () => setLooksOpen(true)}
        workspace={workspace}
        onWorkspace={chooseWorkspace}
      />

      {/*
        The two controls that must never move.
        
        Putting something live and clearing the screen are the only actions
        taken in a hurry, and until now both lived inside the stage panel --
        which is fine while nothing else is happening, and wrong the moment a
        photograph is on the wall through a prayer and the operator is looking
        at the song library. A fixed strip means the hand knows where to go
        without the eye having to find it.
        
        Clear is drawn as the louder of the two on purpose. Going live is a
        decision somebody has already made; clearing is the one taken under
        pressure.
      */}
      <div className="flex shrink-0 items-center gap-2 border-b border-pulpitry-line bg-pulpitry-surface px-3 py-1.5">
        <button
          type="button"
          disabled={!preview}
          onClick={() => display()}
          className="rounded border border-pulpitry-teal/40 bg-pulpitry-teal/10 px-3 py-1 text-[12px] font-medium text-pulpitry-teal disabled:opacity-30 focus-visible:focus-ring"
        >
          Go live
        </button>
        <button
          type="button"
          disabled={!live}
          onClick={() => clearLive()}
          className="rounded border border-pulpitry-gold-dim bg-pulpitry-gold/10 px-3 py-1 text-[12px] font-medium text-pulpitry-gold disabled:opacity-30 focus-visible:focus-ring"
        >
          Clear the screen
        </button>

        {/*
          The reason "Go live" can look broken.
          
          Sending works whether or not a projector window is open -- the content
          is stored either way -- but with no window there is nothing to see, so
          the operator presses it, nothing happens anywhere, and concludes the
          button is dead. It is not; there is simply no screen to send to. Said
          here, with the fix beside it.
        */}
        {/* Beside the projector warning and above the fold, but quiet: an
            operator mid-service should be able to ignore it, and an operator
            packing up should not have to go looking for it. Nothing downloads
            until it is pressed. */}
        {update.version ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={update.install}
              disabled={update.progress !== null}
              title="Download it and restart"
              className="rounded border border-pulpitry-teal/50 px-2 py-1 text-[11.5px] text-pulpitry-teal disabled:opacity-60 focus-visible:focus-ring"
            >
              {update.progress === null
                ? `Version ${update.version} is out — install it`
                : update.progress >= 1
                  ? "Restarting\u2026"
                  : `Downloading\u2026 ${Math.round(update.progress * 100)}%`}
            </button>
            {update.progress === null ? (
              <button
                type="button"
                onClick={update.dismiss}
                aria-label="Dismiss"
                className="rounded px-1 text-[12px] leading-none text-pulpitry-muted hover:text-pulpitry-text focus-visible:focus-ring"
              >
                &times;
              </button>
            ) : null}
          </span>
        ) : null}

        <span className="ml-2 min-w-0 truncate text-[11.5px] text-pulpitry-muted">
          {live ? (
            <>
              <span className="text-pulpitry-gold">On screen</span>{" "}
              {live.caption || bodyText(live.body).slice(0, 80)}
            </>
          ) : (
            "Nothing on screen"
          )}
        </span>
      </div>

      {/*
        Two rows, because the operator does two different things.
        
        The top row is the decision: what was said, what scripture that turned
        out to be, and what is on the wall. The bottom row is the search --
        browsing a chapter, finding a song, picking a slide. Those were side by
        side in three equal columns, which meant the thing being decided and the
        thing being looked for competed for the same width and the eye had no
        anchor.
        
        Detections were a tab inside the library, one click away from the
        operator at the moment they were most needed. They are their own panel
        now, permanently visible beside the transcript that produced them.
      */}
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {/*
          The deck frame: work on the left, output on the right.

          Running a deck is three questions in one glance — what is up, what is
          next, what moves between them — so they share one column, and the
          width that frees goes to the slides, which are read as pictures.
        */}
        {/*
          The song frame: two rows of three.

          A worship set is two jobs at once -- running the song that is up, and
          having the next one ready -- so the top row is the running one (the
          plan, the output, the song's own parts) and the bottom row is the
          finding one (this church's library, the AI Song Finder, and what would be
          added from it).
        */}
        {shape.frame === "song" ? (
          <div
            className="grid min-h-0 flex-1 gap-2"
            style={{ gridTemplateColumns: shape.columns }}
          >
            {/* The work: what the service is doing above, where songs come
                from below. */}
            <div
              className="grid min-h-0 gap-2"
              style={{ gridTemplateRows: `${shape.basis} minmax(0,1fr)` }}
            >
            <div
              className="grid min-h-0 gap-2"
              style={{ gridTemplateColumns: shape.topColumns }}
            >
              {/* The set, not the service. The plan lives on the Plan desk
                  and in the scripture feed's queue; this is what the band is
                  playing, in the order the worship leader put them. */}
              <Panel
                title="Song set"
                accent="teal"
                actions={
                  <PanelCount
                    count={songSet.entries.length}
                    onClear={songSet.clearEntries}
                    title="Empty the set"
                  />
                }
              >
                <QueueRail
                  entries={songSet.entries}
                  name={songSet.name}
                  onStage={stageFromSet}
                  onRemove={songSet.removeAt}
                  activeLabel={live?.caption || null}
                />
              </Panel>

              <SectionsPanel
                song={preview}
                liveKey={liveKey}
                keyOf={keyOf}
                onSelect={chooseSection}
                onLinesChange={changeLines}
              />
            </div>

            <div
              className="grid min-h-0 gap-2"
              style={{ gridTemplateColumns: shape.bottomColumns }}
            >
              <ScripturePanel
                tab={shownTab}
                tabs={shape.tabs}
                onTab={setTab}
                translation={translation}
                translations={library.translations}
                onSelectTranslation={selectTranslation}
                onPreview={(verse, andShow) =>
                  andShow ? showVerse(verse) : previewVerse(verse)
                }
                onPreviewRange={(verses, andShow) =>
                  andShow ? showVerses(verses) : previewVerses(verses)
                }
                previewVerseIds={
                  preview?.kind === "scripture"
                    ? preview.verses.map((verse) => verse.id)
                    : []
                }
                liveVerseIds={live?.ids ?? []}
                index={semanticIndex}
                follow={originalVerse}
                history={history}
                schedule={schedule}
                onStageEntry={stageEntry}
                onPreviewItem={(item, andShow) =>
                  andShow ? showItem(item) : previewItem(item)
                }
                keyOf={keyOf}
                previewKey={preview ? keyOf(preview) : null}
                liveKey={liveKey}
                theme={look}
                onApplyTheme={applyTheme}
                ticker={ticker}
                onTickerChange={changeTicker}
                onError={setError}
                libraryReady={library.ready && Boolean(translation)}
                libraryImporting={library.importing}
                libraryError={library.error}
                onAddToSet={(item) => songSet.add(item)}
              />

              <SongFinderPanel
                /* The courtesy gate. The real one is the broker's: the
                   endpoint refuses a machine that is not activated. */
                subscribed={settings?.hasHostedSubscription ?? false}
                chosen={found?.id ?? null}
                onChoose={setSongFinderHit}
              />

              <ImportPreview
                hit={found}
                onAdded={(item) => {
                  /* Staged, not sent: adding a song is finishing a decision
                     about the library, and the wall is a separate one. */
                  const staged = presentableFor(item);
                  if (staged) previewItem(staged);
                  setNotice(`${item.title} was added to your song library.`);
                  setSongFinderHit(null);
                }}
                onError={setError}
              />
            </div>
            </div>

            {/* The same output column as the slide desk, in the same place and
                the same shape: an operator moves between these two
                arrangements during one service. */}
            <MainOutput
                preview={preview}
                live={live}
                onDisplay={display}
                onClear={clearLive}
                onStep={(forward) => void step(forward)}
                canFollow={follow.canFollow}
                following={follow.following}
                onFollowChange={(on) =>
                  on ? follow.setFollowing(true) : follow.stop()
                }
                advance={follow.advance}
                onAdvanceChange={follow.setAdvance}
                suggestion={follow.suggestion}
                onTakeSuggestion={(index) => {
                  goToSlide(index + 1);
                  follow.clearSuggestion();
                }}
                onWind={wind}
                /* Into the set here, because that is the list in front of the
                   operator. Everywhere else Add means the running order. */
                onAdd={() => preview && songSet.add(preview)}
                theme={look}
                canStepBack={canStepBack}
                canStepForward={canStepForward}
                projectorOpen={projector.open}
                audio={audio}
                onAudioChange={changeAudio}
                media={media}
                ticker={ticker}
              />
          </div>
        ) : null}

        {shape.frame === "deck" ? (
          <div
            className="grid min-h-0 flex-1 gap-2"
            style={{ gridTemplateColumns: shape.columns }}
          >
            {/* Rows rather than a flex column: a grid child stretches to its
                track, so the library fills whatever the deck strip leaves. */}
            <div
              className="grid min-h-0 gap-2"
              style={{ gridTemplateRows: `${shape.basis} minmax(0,1fr)` }}
            >
              <DeckStrip
                deck={preview}
                liveKey={liveKey}
                keyOf={keyOf}
                theme={look}
                /* One click stages, two puts it up -- the same rule as every
                   other list in the window. Built from the staged deck rather
                   than through goToSlide, which keeps whatever was live live:
                   right for a spoken instruction, wrong for a click. */
                onSelect={chooseSection}
              />

              <ScripturePanel
                tab={shownTab}
                tabs={shape.tabs}
                onTab={setTab}
                translation={translation}
                translations={library.translations}
                onSelectTranslation={selectTranslation}
                onPreview={(verse, andShow) =>
                  andShow ? showVerse(verse) : previewVerse(verse)
                }
                onPreviewRange={(verses, andShow) =>
                  andShow ? showVerses(verses) : previewVerses(verses)
                }
                previewVerseIds={
                  preview?.kind === "scripture"
                    ? preview.verses.map((verse) => verse.id)
                    : []
                }
                liveVerseIds={live?.ids ?? []}
                index={semanticIndex}
                follow={originalVerse}
                history={history}
                schedule={schedule}
                onStageEntry={stageEntry}
                onPreviewItem={(item, andShow) =>
                  andShow ? showItem(item) : previewItem(item)
                }
                keyOf={keyOf}
                previewKey={preview ? keyOf(preview) : null}
                liveKey={liveKey}
                theme={look}
                onApplyTheme={applyTheme}
                ticker={ticker}
                onTickerChange={changeTicker}
                onError={setError}
                libraryReady={library.ready && Boolean(translation)}
                libraryImporting={library.importing}
                libraryError={library.error}
              />
            </div>

            <MainOutput
              preview={preview}
              live={live}
              onDisplay={display}
              onClear={clearLive}
              onStep={(forward) => void step(forward)}
              canFollow={follow.canFollow}
              following={follow.following}
              onFollowChange={(on) =>
                on ? follow.setFollowing(true) : follow.stop()
              }
              advance={follow.advance}
              onAdvanceChange={follow.setAdvance}
              suggestion={follow.suggestion}
              onTakeSuggestion={(index) => {
                goToSlide(index + 1);
                follow.clearSuggestion();
              }}
              onWind={wind}
              onAdd={() => preview && schedule.add(preview)}
              theme={look}
              canStepBack={canStepBack}
              canStepForward={canStepForward}
              projectorOpen={projector.open}
              audio={audio}
              onAudioChange={changeAudio}
              media={media}
              ticker={ticker}
            />
          </div>
        ) : null}

        {shape.frame === "desk" ? (
        <div
          className="grid min-h-0 flex-1 gap-2"
          style={{ gridTemplateColumns: shape.topColumns }}
        >
          {/* The transcript is the input to verse detection. During a worship
              set or a notice slide it is a column of words nobody reads, and
              its width is what the song library and a deck need. */}
          {shape.transcript ? (
          <TranscriptPanel
            lines={lines}
            interim={interim}
            status={status}
            onClear={clear}
            onExport={() => void saveTranscript()}
            onOpenHistory={() => setHistoryOpen(true)}
            exporting={exporting}
          />
          ) : null}

          {shape.detected ? (
          <Panel
            title="Detected"
            actions={
              <PanelCount
                count={
                  detections.length + references.length + suggestions.length
                }
                onClear={clearHeard}
                title="Empty this list"
              />
            }
          >
            <Detections
              detections={detections}
              references={references}
              suggestions={suggestions}
              onPreview={(verse, andShow) =>
                andShow ? showVerse(verse) : previewVerse(verse)
              }
              previewVerseId={
                preview?.kind === "scripture"
                  ? (preview.verses[0]?.id ?? null)
                  : null
              }
              liveVerseId={live?.ids?.[0] ?? null}
              listening={active}
              index={semanticIndex}
              assistEnabled={settings?.assistEnabled ?? false}
            />
          </Panel>
          ) : null}

          <StagePanel
            preview={preview}
            live={live}
            onDisplay={display}
            onClear={clearLive}
            onStep={(forward) => void step(forward)}
            canFollow={follow.canFollow}
            following={follow.following}
            onFollowChange={(on) =>
              on ? follow.setFollowing(true) : follow.stop()
            }
            advance={follow.advance}
            onAdvanceChange={follow.setAdvance}
            suggestion={follow.suggestion}
            onTakeSuggestion={(index) => {
              goToSlide(index + 1);
              follow.clearSuggestion();
            }}
            onWind={wind}
            onAdd={() => preview && schedule.add(preview)}
            theme={look}
            canStepBack={canStepBack}
            canStepForward={canStepForward}
            projectorOpen={projector.open}
            audio={audio}
            onAudioChange={changeAudio}
            media={media}
            ticker={ticker}
          />
          {/*
            On the scripture desk the queue is half a pane: the other half is
            what has already been read. Two lists, one glance, and the same
            running order underneath -- putting a verse aside to come back to
            and putting it in the plan are the same act.
          */}
          {shape.feed ? (
            <ScriptureFeed
              history={history}
              onClearHistory={clearHistory}
              entries={schedule.entries}
              name={schedule.name}
              onStage={stageFromQueue}
              onRemove={schedule.removeAt}
              onClearEntries={schedule.clearEntries}
              onPreviewItem={(item, andShow) =>
                andShow ? showItem(item) : previewItem(item)
              }
              keyOf={keyOf}
              previewKey={preview ? keyOf(preview) : null}
              liveKey={liveKey}
              activeLabel={live?.caption || null}
            />
          ) : null}

          {shape.queue ? (
          <Panel
            title="Queue"
            actions={
              <PanelCount
                count={schedule.entries.length}
                onClear={schedule.clearEntries}
                title="Empty the running order"
              />
            }
          >
            <QueueRail
              entries={schedule.entries}
              name={schedule.name}
              onStage={stageFromQueue}
              onRemove={schedule.removeAt}
              activeLabel={live?.caption || null}
            />
          </Panel>
          ) : null}
        </div>
        ) : null}

        {/*
          Fixed share of the height rather than a third of the width: a chapter
          is read down, not across, and eight verses visible beats three.

          Three columns, left to right: the library, the original languages, and
          what is staged next. Each is a step in the same movement — find the
          verse, look into it, then check what will go up — so they read across
          in the order the operator works.

          Preview is given real width rather than the strip it started as. It
          draws the projector's own theme and backdrop, and a themed slide
          squeezed into a narrow column tells an operator nothing about what
          will fit on the wall.

          The count must match the children. This grid had two columns and three
          panels for one build, and the third silently wrapped onto a second row
          underneath the library rather than sitting beside it.
        */}
        {shape.frame === "desk" ? (
        <div
          className="grid min-h-0 gap-2"
          style={{ flexBasis: shape.basis, gridTemplateColumns: shape.columns }}
        >
          <ScripturePanel
            tab={shownTab}
            tabs={shape.tabs}
            onTab={setTab}
            translation={translation}
            translations={library.translations}
            onSelectTranslation={selectTranslation}
            onPreview={(verse, andShow) =>
              andShow ? showVerse(verse) : previewVerse(verse)
            }
            onPreviewRange={(verses, andShow) =>
              andShow ? showVerses(verses) : previewVerses(verses)
            }
            previewVerseIds={
              preview?.kind === "scripture"
                ? preview.verses.map((verse) => verse.id)
                : []
            }
            /* The same verse the Original panel follows, so the chapter list and
             the Greek beside it are never looking at different places. */
            liveVerseIds={live?.ids ?? []}
            /* So the pane can search by meaning, and say why it cannot when
               the index is still building or switched off. */
            index={semanticIndex}
            follow={originalVerse}
            history={history}
            schedule={schedule}
            onStageEntry={stageEntry}
            onPreviewItem={(item, andShow) =>
              andShow ? showItem(item) : previewItem(item)
            }
            keyOf={keyOf}
            previewKey={preview ? keyOf(preview) : null}
            liveKey={liveKey}
            theme={look}
            onApplyTheme={applyTheme}
            ticker={ticker}
            onTickerChange={changeTicker}
            onError={setError}
            libraryReady={library.ready && Boolean(translation)}
            libraryImporting={library.importing}
            libraryError={library.error}
          />

          {/*
          Beside the library rather than in the rail.
          
          A verse laid out word by word needs width -- cards wrap, and in a
          narrow rail every one of them would be a column one word wide. It also
          belongs next to the thing it explains: an operator reading a chapter
          is the operator who wants to know what a word is doing in it.
        */}
          {shape.original ? (
          <OriginalPanel
            verse={originalVerse}
            onOpenLexicon={openLexicon}
            lexicon={lexicon}
            lexiconLooking={lexiconLooking}
            lexiconAt={lexiconAt}
            onProjectLexiconText={(title, body, andShow) => {
              /*
               * A definition on the wall, under the word it defines.
               *
               * The heading is the word — a congregation reading a paragraph of
               * Abbott-Smith needs to know which word it is about, and the name
               * of the lexicon tells them nothing they can use. The body keeps
               * its paragraph breaks, because sense numbering is most of what
               * makes an entry readable at all.
               */
              const item = {
                kind: "slide" as const,
                itemId: -1,
                title,
                blocks: [
                  {
                    text: title,
                    level: "heading" as const,
                    align: "center" as const,
                    bold: true,
                    italic: false,
                  },
                  ...body
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => ({
                      text: line,
                      // Left, not centred. A definition is prose and runs to
                      // several lines; centred prose is read a line at a time
                      // by somebody hunting for where each one starts.
                      level: "body" as const,
                      align: "left" as const,
                      bold: false,
                      italic: false,
                    })),
                ],
              };
              if (andShow) showItem(item);
              else previewItem(item);
            }}
            onProjectLexicon={(entry, andShow) => {
              /*
               * The word, how to say it, and what it means. The definitions go
               * up through `onProjectLexiconText`, a paragraph at a time; this
               * is the word itself, which is what most of a service needs.
               */
              const item = {
                kind: "slide" as const,
                itemId: -1,
                title: `${entry.lemma} — ${entry.strongs}`,
                blocks: [
                  {
                    text: entry.lemma,
                    level: "heading" as const,
                    align: "center" as const,
                    bold: true,
                    italic: false,
                  },
                  ...(entry.transliteration
                    ? [
                        {
                          text: entry.transliteration,
                          level: "body" as const,
                          align: "center" as const,
                          bold: false,
                          italic: true,
                        },
                      ]
                    : []),
                  ...(entry.gloss
                    ? [
                        {
                          text: entry.gloss,
                          level: "body" as const,
                          align: "center" as const,
                          bold: false,
                          italic: false,
                        },
                      ]
                    : []),
                ],
              };
              if (andShow) showItem(item);
              else previewItem(item);
            }}
            onStage={(word, reference, andShow) => {
              /*
               * Three lines: the word, how to say it, what it means. Not the
               * Strong's number and not the morphology -- those are how the
               * operator knows they have the right word, and a congregation
               * reading "V-AAI-3S" has been shown our workings rather than the
               * point.
               */
              const item = {
                kind: "slide" as const,
                itemId: -1,
                title: `${word.original} — ${reference}`,
                blocks: [
                  {
                    text: word.original,
                    level: "heading" as const,
                    align: "center" as const,
                    bold: true,
                    italic: false,
                  },
                  ...(word.transliteration
                    ? [
                        {
                          text: word.transliteration,
                          level: "body" as const,
                          align: "center" as const,
                          bold: false,
                          italic: true,
                        },
                      ]
                    : []),
                  ...(word.gloss
                    ? [
                        {
                          text: word.gloss,
                          level: "body" as const,
                          align: "center" as const,
                          bold: false,
                          italic: false,
                        },
                      ]
                    : []),
                ],
              };
              if (andShow) showItem(item);
              else previewItem(item);
            }}
          />
          ) : null}

          <PreviewPanel
            preview={preview}
            theme={look}
          />
        </div>
        ) : null}
      </main>

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-pulpitry-line bg-pulpitry-surface px-3 text-[11.5px]">
        {footer ? (
          <span
            className={
              status.state === "error" || error || library.error
                ? "text-pulpitry-gold"
                : "text-pulpitry-muted"
            }
          >
            {footer}
          </span>
        ) : (
          <span className="text-pulpitry-muted">
            {status.device ? `Listening on ${status.device}` : "Ready"}
          </span>
        )}
      </footer>

      {looksOpen ? (
        <TemplateLibrary
          theme={look}
          deskLabel={shape.label}
          onApply={applyTheme}
          onClose={() => setLooksOpen(false)}
          onError={setError}
        />
      ) : null}

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}

      {slidesOpen ? (
        <SlidesFromSermon onClose={() => setSlidesOpen(false)} />
      ) : null}

      {historyOpen ? (
        <HistoryDialog
          onClose={() => setHistoryOpen(false)}
          engine={settings?.speechEngine ?? "local"}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
        />
      ) : null}

      {outputsOpen && settings ? (
        <OutputsDialog
          settings={settings}
          live={live}
          ticker={ticker}
          onClose={() => setOutputsOpen(false)}
          onSaved={setSettings}
        />
      ) : null}
    </div>
  );
}
