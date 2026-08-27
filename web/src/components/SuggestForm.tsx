import { useState, type FormEvent } from "react";
import { submitMovieSuggestion } from "../lib/firebase-core";

export default function SuggestForm() {
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    setStatus("submitting");
    setErrorMessage("");

    try {
      await submitMovieSuggestion(data);
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not submit suggestion. Please try again.");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-2xl border border-emerald/30 bg-emerald-soft p-6 text-left">
        <h3 className="font-display text-lg font-semibold text-ink">Thanks for your suggestion!</h3>
        <p className="mt-2 text-sm text-ink-soft">Our team reviews requests before adding them to a future vote.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <div>
        <label htmlFor="title" className="mb-1.5 block text-sm font-medium text-ink">
          Movie title and year
        </label>
        <input
          id="title"
          name="title"
          required
          type="text"
          placeholder="e.g. Paris, Texas (1984)"
          className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
        />
      </div>
      <div>
        <label htmlFor="why" className="mb-1.5 block text-sm font-medium text-ink">
          Why this movie?
        </label>
        <textarea
          id="why"
          name="why"
          required
          rows={4}
          placeholder="What makes this a great pick for a community movie night?"
          className="w-full resize-y rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
        />
      </div>
      <button
        type="submit"
        disabled={status === "submitting"}
        className="rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "submitting" ? "Submitting…" : "Submit suggestion"}
      </button>
      {status === "error" && <p className="text-sm text-red-600">{errorMessage}</p>}
    </form>
  );
}
