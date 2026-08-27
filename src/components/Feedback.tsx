import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * A report that arrives usable, rather than "it stopped working".
 *
 * # Why the three questions
 *
 * Every support thread that goes badly goes badly the same way: a sentence
 * describing a symptom, then four exchanges establishing what the person was
 * doing, what they expected, and what happened instead. Asking for those three
 * up front is not a form for its own sake — it is the four exchanges, asked
 * once, while the person still remembers.
 *
 * # Why it opens a mail client rather than posting
 *
 * The report goes to support@castavox.com as an ordinary email. It costs no
 * endpoint, no storage and no privacy policy change, and it leaves the church
 * holding a copy in their own sent items — which matters when the thing they
 * are reporting is that something of theirs went missing.
 *
 * The cost is real and worth stating: a machine with no mail client configured
 * gets nothing, so the address is shown as text that can be copied and the body
 * is never lost behind a button that silently did nothing.
 */
export function Feedback() {
  const [kind, setKind] = useState<"bug" | "idea">("bug");
  const [email, setEmail] = useState("");
  const [doing, setDoing] = useState("");
  const [expected, setExpected] = useState("");
  const [happened, setHappened] = useState("");
  const [idea, setIdea] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [about, setAbout] = useState("");

  useEffect(() => {
    let live = true;
    // The browser's own string rather than a plugin: this only has to tell
    // support which machine it was, and adding a dependency for that is a
    // dependency to keep updated forever.
    void getVersion()
      .then(
        (app) => live && setAbout(`Pulpitry ${app} · ${navigator.userAgent}`),
      )
      .catch(() => live && setAbout(""));
    return () => {
      live = false;
    };
  }, []);

  /*
   * The version and platform go in the body, not left to be asked for.
   *
   * They are the first two questions of every thread and the two an operator
   * cannot answer without being walked to an About box. Nothing else is
   * attached: no transcript, no verse, no audio. The log is a separate,
   * deliberate button in Help, because a log is a file somebody should choose
   * to send rather than one that rides along unnoticed.
   */
  const body =
    kind === "bug"
      ? [
          `What I was doing:\n${doing.trim() || "—"}`,
          `What I expected:\n${expected.trim() || "—"}`,
          `What happened instead:\n${happened.trim() || "—"}`,
          blocking ? "\nThis stops us using Pulpitry." : "",
          `\n---\n${about}`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : `${idea.trim() || "—"}\n\n---\n${about}`;

  const subject =
    kind === "bug"
      ? `Pulpitry bug${blocking ? " (blocking)" : ""}`
      : "Pulpitry — an idea";

  const ready =
    kind === "bug" ? happened.trim().length > 0 : idea.trim().length > 0;

  const send = () => {
    const to = "support@castavox.com";
    const query = new URLSearchParams({ subject, body });
    if (email.trim()) query.set("cc", email.trim());
    void openUrl(`mailto:${to}?${query.toString()}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1">
        {(
          [
            ["bug", "Something is wrong"],
            ["idea", "An idea"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            className={`rounded px-3 py-1.5 text-[12px] transition-colors focus-visible:focus-ring ${
              kind === id
                ? "bg-pulpitry-raised text-pulpitry-text"
                : "text-pulpitry-muted hover:text-pulpitry-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {kind === "bug" ? (
        <>
          <Field
            label="What were you doing?"
            value={doing}
            onChange={setDoing}
            placeholder="Staging a verse during the sermon…"
          />
          <Field
            label="What did you expect?"
            value={expected}
            onChange={setExpected}
            placeholder="The verse to appear on the projector."
          />
          <Field
            label="What happened instead?"
            value={happened}
            onChange={setHappened}
            placeholder="The projector went black and stayed black."
          />
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={blocking}
              onChange={(event) => setBlocking(event.target.checked)}
              className="h-3.5 w-3.5 accent-pulpitry-gold focus-visible:focus-ring"
            />
            <span className="text-[13px] text-pulpitry-text">
              This stops us using Pulpitry
            </span>
          </label>
        </>
      ) : (
        <Field
          label="What would you like it to do?"
          value={idea}
          onChange={setIdea}
          placeholder="Show the next song's first line while the current one is up…"
          rows={5}
        />
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] text-pulpitry-muted">
          Your email, if you would like a reply
        </span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@yourchurch.org"
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[13px] text-pulpitry-text outline-none focus-visible:focus-ring"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={send}
          disabled={!ready}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
        >
          Write the email
        </button>
        {/* Shown whether or not a mail client exists, because on a machine with
            none the button does nothing and the address is the whole answer. */}
        <span className="text-[11.5px] text-pulpitry-muted">
          Opens your mail app, addressed to support@castavox.com. Nothing is
          sent until you send it.
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  rows?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] text-pulpitry-muted">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="resize-y rounded border border-pulpitry-line bg-pulpitry-raised px-2.5 py-1.5 text-[13px] leading-relaxed text-pulpitry-text outline-none focus-visible:focus-ring"
      />
    </label>
  );
}
