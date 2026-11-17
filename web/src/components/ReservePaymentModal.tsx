import { useEffect, useMemo, useRef, useState } from "react";
import type { Stripe, StripeElements } from "@stripe/stripe-js";

// Crowd-pledge card capture: the supporter picks a pledge amount (>= the
// campaign minimum) and saves a card via a Stripe SetupIntent
// (usage: off_session). Nothing is charged here — the backend charges all
// saved cards only once total pledges cover the licensing fee target and the
// screening is confirmed. Stripe.js loads lazily, only when the modal opens.
export default function ReservePaymentModal({
  clientSecret,
  publishableKey,
  minAmountCents,
  licensingFeeCents = null,
  totalPledgedCents = 0,
  campaignTitle,
  onSuccess,
  onCancel,
}: {
  clientSecret: string;
  publishableKey: string;
  minAmountCents: number;
  licensingFeeCents?: number | null;
  totalPledgedCents?: number;
  campaignTitle: string;
  onSuccess: (setupIntentId: string, amountCents: number) => void;
  onCancel: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const minCents = Math.max(50, Math.round(minAmountCents || 0));
  const [amountCents, setAmountCents] = useState<number>(minCents);
  const [customAmount, setCustomAmount] = useState<string>("");

  const presetAmounts = useMemo(() => {
    const presets = [minCents, 2500, 5000];
    return Array.from(new Set(presets.filter((cents) => cents >= minCents))).sort((a, b) => a - b);
  }, [minCents]);

  const formatDollars = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2).replace(/\.00$/, "")}`;
  const amountLabel = formatDollars(amountCents);

  const targetCents = Math.max(0, Math.round(licensingFeeCents || 0));
  const pledgedCents = Math.max(0, Math.round(totalPledgedCents || 0));
  const progressPct = targetCents > 0 ? Math.min(100, Math.round(((pledgedCents + amountCents) / targetCents) * 100)) : null;

  function selectCustomAmount(raw: string) {
    setCustomAmount(raw);
    setError("");
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      setAmountCents(Math.round(parsed * 100));
    }
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { loadStripe } = await import("@stripe/stripe-js");
        const stripe = await loadStripe(publishableKey);
        if (cancelled) return;
        if (!stripe) {
          setError("Could not load the payment form. Please try again later.");
          return;
        }
        stripeRef.current = stripe;
        const elements = stripe.elements({ clientSecret, appearance: { theme: "stripe" } });
        elementsRef.current = elements;
        const paymentElement = elements.create("payment");
        if (mountRef.current) {
          paymentElement.mount(mountRef.current);
          paymentElement.on("ready", () => setReady(true));
        }
      } catch {
        if (!cancelled) setError("Could not load the payment form. Please try again later.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientSecret, publishableKey]);

  async function handleSubmit() {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements || submitting) return;

    if (!Number.isInteger(amountCents) || amountCents < minCents) {
      setError(`Pledge at least ${formatDollars(minCents)}.`);
      return;
    }
    if (amountCents > 100000) {
      setError("Pledges are capped at $1,000.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const result = await stripe.confirmSetup({ elements, redirect: "if_required" });
      if (result.error) {
        setError(result.error.message || "Could not save your card. Please try again.");
        setSubmitting(false);
        return;
      }
      if (result.setupIntent?.status === "succeeded") {
        onSuccess(result.setupIntent.id, amountCents);
        return;
      }
      setError("Card setup did not complete. Please try again.");
      setSubmitting(false);
    } catch {
      setError("Could not save your card. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl">
        <h3 className="font-display text-xl font-semibold text-ink">Pledge to make it happen</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Pledge toward <span className="font-semibold text-ink">{campaignTitle || "this screening"}</span>.
          You are <span className="font-semibold text-ink">not charged now</span> — your card is only charged{" "}
          <span className="font-semibold text-ink">{amountLabel}</span> once pledges cover the licensing fee and the
          screening is confirmed. If the goal isn't reached, you're never charged.
        </p>

        {progressPct !== null && (
          <div className="mt-3 rounded-xl border border-line bg-cream p-3">
            <div className="flex items-center justify-between text-[11px] font-semibold text-ink-soft">
              <span>
                {formatDollars(pledgedCents)} pledged of {formatDollars(targetCents)} licensing fee
              </span>
              <span className="text-emerald">+{amountLabel} you</span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line/60">
              <div
                className="h-full rounded-full bg-emerald transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Your pledge (min {formatDollars(minCents)})
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {presetAmounts.map((cents) => {
              const active = amountCents === cents && !customAmount;
              return (
                <button
                  key={cents}
                  type="button"
                  onClick={() => {
                    setCustomAmount("");
                    setError("");
                    setAmountCents(cents);
                  }}
                  aria-pressed={active}
                  className={`rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                    active
                      ? "border-marquee bg-marquee/10 text-marquee"
                      : "border-line text-ink-soft hover:border-marquee hover:text-marquee"
                  }`}
                >
                  {formatDollars(cents)}
                </button>
              );
            })}
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold text-ink-soft">$</span>
              <input
                type="number"
                min={minCents / 100}
                step="1"
                inputMode="decimal"
                value={customAmount}
                onChange={(event) => selectCustomAmount(event.target.value)}
                placeholder="Other"
                className="w-20 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-sm text-ink outline-none transition-colors focus:border-marquee"
              />
            </div>
          </div>
        </div>

        <div className="mt-4 min-h-[120px]">
          {!ready && !error && <div className="skeleton h-28 w-full rounded-xl" />}
          <div ref={mountRef} />
        </div>

        {error && <p className="mt-3 text-sm font-semibold text-red-500">{error}</p>}

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-marquee hover:text-marquee disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!ready || submitting || amountCents < minCents}
            className="rounded-full bg-marquee px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-marquee/90 disabled:opacity-50"
          >
            {submitting ? "Saving…" : `Pledge ${amountLabel} — charged only if confirmed`}
          </button>
        </div>
      </div>
    </div>
  );
}
