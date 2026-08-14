import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * What this is, what version it is, and what is inside it.
 *
 * The native About panel would have done the first two and none of the third.
 * The third is the part worth having: Pulpitry ships other people's work — a
 * speech model, a Bible library, a hymn book — and a church running it in
 * public should be able to find out whose, without leaving the application and
 * without taking our word for it.
 *
 * It is also where the version goes when somebody is on the phone describing a
 * problem, which is the only moment anybody ever wants a version number.
 */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const link = (url: string, label: string) => (
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className="text-pulpitry-teal underline-offset-2 hover:underline focus-visible:focus-ring"
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="About Pulpitry"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-[440px] flex-col overflow-auto rounded-lg border border-pulpitry-line bg-pulpitry-surface shadow-2xl p-6"
      >
        <h2 className="text-[19px] text-pulpitry-text">Pulpitry</h2>
        <p className="mt-1 text-[12.5px] text-pulpitry-muted">
          {version ? `Version ${version}` : " "}
        </p>

        <p className="mt-4 text-[13px] leading-relaxed text-pulpitry-text">
          An operator&rsquo;s desk for a church service: scripture, songs, slides and media on a
          projector, with the passage a speaker is quoting found as they say it.
        </p>

        {/* Whose it is. The first version of this dialog listed everybody
            else's work and not the author's, which is the wrong way round for
            a page headed About. */}
        <p className="mt-4 text-[13px] text-pulpitry-text">
          Made by <span className="text-pulpitry-gold">Ayorinde G. Smart</span>
        </p>
        <p className="mt-1 text-[12px] text-pulpitry-muted">
          © {new Date().getFullYear()} Castavox. All rights reserved.
        </p>

        {/* The part the native panel could not do. A church running this in
            public should be able to find out whose work is inside it without
            leaving the application. */}
        <h3 className="mt-6 text-[12px] uppercase tracking-[0.14em] text-pulpitry-muted">
          Built on
        </h3>
        <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px] leading-snug text-pulpitry-muted">
          <li>
            Transcription on this machine by{" "}
            {link("https://github.com/ggerganov/whisper.cpp", "whisper.cpp")}, which is MIT
            licensed. The models are fetched from its own repository.
          </li>
          <li>
            Eleven public-domain Bible translations, about 342,000 verses, bundled and searched
            locally. Copyrighted translations are fetched from their publishers with a key you
            hold — we redistribute none of them.
          </li>
          <li>266 public-domain hymns.</li>
          <li>
            Paraphrase matching by a sentence-embedding model that runs here, so no text leaves
            this machine for it.
          </li>
        </ul>

        <h3 className="mt-6 text-[12px] uppercase tracking-[0.14em] text-pulpitry-muted">
          Help and licences
        </h3>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]">
          {link("https://www.castavox.com/pulpitry/manual", "Manual")}
          {link("https://www.castavox.com/pricing", "Subscription")}
          {link("https://www.castavox.com/privacy", "Privacy")}
          {link("https://www.castavox.com/terms", "Terms")}
        </div>

        <p className="mt-6 text-[11.5px] leading-relaxed text-pulpitry-muted">
          Everything except hosted transcription and the assistant works with no account and no
          network at all.
        </p>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-pulpitry-line bg-pulpitry-raised px-3 py-1.5 text-[13px] text-pulpitry-text focus-visible:focus-ring"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
