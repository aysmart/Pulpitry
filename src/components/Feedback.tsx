import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { describeError, sendFeedback } from "../lib/api";

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
 * # Why it posts rather than opening a mail client
 *
 * A mail link costs nothing to build and fails on exactly the machine most
 * likely to have something to report: a church laptop with no mail client
 * configured, where the button appears to do nothing at all. It also loses the
 * report whenever the operator is not the person whose email account is on the
 * machine, which at a church is most of the time.
 *
 * So the broker takes it and sends it on. The person needs nothing but the
 * application they are already unhappy with — and if the send fails, they are
 * told, and given the address.
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
  const [sent, setSent] = useState(false);

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

  const ready =
    kind === "bug" ? happened.trim().length > 0 : idea.trim().length > 0;

  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const send = async () => {
    setSending(true);
    setOutcome(null);
    try {
      await sendFeedback({
        kind,
        text: body,
        email: email.trim(),
        platform: about,
      });
      setSent(true);
    } catch (err) {
      setOutcome(describeError(err));
    } finally {
      setSending(false);
    }
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
          onClick={() => void send()}
          disabled={!ready || sending || sent}
          className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[12px] text-pulpitry-text disabled:opacity-40 focus-visible:focus-ring"
        >
          {sending ? "Sending…" : sent ? "Sent" : "Send"}
        </button>

        {/*
          Three states, said in words. "Sent" is the one that matters: somebody
          who is not sure whether it went will send it again, and a support
          inbox with the same report three times is how the third one gets read
          as the first.
        */}
        {sent ? (
          <span className="text-[11.5px] text-pulpitry-muted">
            Thank you — it reached us. We read every one.
          </span>
        ) : outcome ? (
          // The failure names the address, because that is the thing they can
          // still do about it.
          <span className="text-[11.5px] leading-snug text-pulpitry-gold">
            {outcome} You can write to support@castavox.com instead.
          </span>
        ) : (
          <span className="text-[11.5px] text-pulpitry-muted">
            Goes to support@castavox.com. Nothing else is attached — no
            transcript, no verses, no audio.
          </span>
        )}
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
