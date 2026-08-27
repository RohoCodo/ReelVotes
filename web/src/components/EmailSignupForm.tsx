import { useState, type FormEvent } from "react";
import { addEmailSignup } from "../lib/firebase-core";

interface Props {
  eventId?: string;
}

export default function EmailSignupForm({ eventId = "newparkway1" }: Props) {
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (new FormData(form).get("email") as string || "").trim();

    if (!email || !email.includes("@")) {
      setStatus("error");
      setErrorMessage("Please enter a valid email address.");
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      await addEmailSignup({ email, eventId });
      form.reset();
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not save your email. Please try again.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-[1fr_auto]">
      <label htmlFor="email" className="sr-only">
        Email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        placeholder="you@example.com"
        autoComplete="email"
        className="w-full rounded-full border border-line bg-paper px-5 py-3.5 text-sm text-ink outline-none transition-colors focus:border-marquee"
      />
      <button
        type="submit"
        disabled={status === "submitting"}
        className="whitespace-nowrap rounded-full bg-marquee px-6 py-3.5 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "submitting" ? "Joining…" : "Get voting alerts"}
      </button>
      <p className="sm:col-span-2 text-xs text-ink-faint">
        Unsubscribe anytime. Alerts are focused on real voting activity and ticket releases.
      </p>
      {status === "done" && (
        <p className="sm:col-span-2 text-sm font-medium text-emerald">
          You're on the list! We'll email you when votes open, winners are announced, and tickets go live.
        </p>
      )}
      {status === "error" && <p className="sm:col-span-2 text-sm text-red-600">{errorMessage}</p>}
    </form>
  );
}
