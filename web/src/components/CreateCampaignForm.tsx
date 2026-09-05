import { useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { createCampaign } from "../lib/firebase";
import { auth, isPopupSignInCancellation, onAuthStateChanged, signInWithGoogle, signOut } from "../lib/firebase-auth";
import { CAMPAIGN_MOVIE_CHOICES_REQUIRED } from "../lib/campaign-policy";
import { searchMoviesByQuery, type MovieSearchResult } from "../lib/tmdb";
import { publicListDeadTimeSlots, publicListTheaters } from "../lib/firebase-core";

type DeadTimeSlotOption = {
  slotId: string;
  theaterKey: string;
  theaterName: string;
  market: string;
  dayOfWeek: string;
  timeLabel: string;
  screeningDateTime: string;
  label: string;
  ticketPrice: number | null;
  licensingFee: number | null;
};

type SubmitState = "idle" | "submitting" | "success";

function splitTheaters(value: string): string[] {
  return String(value || "")
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function sanitizeCurrency(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}

function computeAutoBackingThreshold(ticketPrice: number | null, licensingFee: number | null): number | null {
  if (!ticketPrice || !licensingFee) return null;
  return Math.max(10, Math.min(1000, Math.ceil(licensingFee / ticketPrice)));
}

export default function CreateCampaignForm() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [market, setMarket] = useState("");
  const [citySuggestions, setCitySuggestions] = useState<string[]>([]);
  const [citySearchLoading, setCitySearchLoading] = useState(false);
  const [showCitySuggestions, setShowCitySuggestions] = useState(false);
  const [deadTimeSlots, setDeadTimeSlots] = useState<DeadTimeSlotOption[]>([]);
  const [deadTimeLoading, setDeadTimeLoading] = useState(false);
  const [selectedDeadTimeSlotId, setSelectedDeadTimeSlotId] = useState("");
  const [choices, setChoices] = useState<string[]>(["", "", ""]);
  const [movieSuggestionsByIndex, setMovieSuggestionsByIndex] = useState<Record<number, MovieSearchResult[]>>({
    0: [],
    1: [],
    2: [],
  });
  const [movieSearchLoadingByIndex, setMovieSearchLoadingByIndex] = useState<Record<number, boolean>>({
    0: false,
    1: false,
    2: false,
  });
  const [activeMovieInputIndex, setActiveMovieInputIndex] = useState<number | null>(null);
  const [selectedPreferredTheater, setSelectedPreferredTheater] = useState("");

  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const query = market.trim();
    if (query.length < 2 || !showCitySuggestions) {
      setCitySuggestions([]);
      setCitySearchLoading(false);
      return;
    }

    let cancelled = false;
    setCitySearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response: any = await publicListTheaters({ query, limit: 40 });
        if (cancelled) return;
        const theaters = Array.isArray(response?.data?.theaters) ? response.data.theaters : [];
        const deduped = new Set<string>();
        theaters.forEach((row: any) => {
          const city = String(row?.theater_city_state || row?.city || "").trim();
          if (city) deduped.add(city);
        });
        setCitySuggestions(Array.from(deduped).slice(0, 12));
      } catch {
        if (!cancelled) setCitySuggestions([]);
      } finally {
        if (!cancelled) setCitySearchLoading(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [market, showCitySuggestions]);

  useEffect(() => {
    const timers = choices.map((rawTitle, index) => {
      const query = rawTitle.trim();
      if (query.length < 2) {
        setMovieSuggestionsByIndex((prev) => ({ ...prev, [index]: [] }));
        setMovieSearchLoadingByIndex((prev) => ({ ...prev, [index]: false }));
        return null;
      }

      setMovieSearchLoadingByIndex((prev) => ({ ...prev, [index]: true }));

      return window.setTimeout(async () => {
        try {
          const results = await searchMoviesByQuery(query, 8);
          setMovieSuggestionsByIndex((prev) => ({ ...prev, [index]: results }));
        } catch {
          setMovieSuggestionsByIndex((prev) => ({ ...prev, [index]: [] }));
        } finally {
          setMovieSearchLoadingByIndex((prev) => ({ ...prev, [index]: false }));
        }
      }, 220);
    });

    return () => {
      timers.forEach((timer) => {
        if (timer) window.clearTimeout(timer);
      });
    };
  }, [choices]);

  useEffect(() => {
    const marketQuery = market.trim();
    if (marketQuery.length < 2) {
      setDeadTimeSlots([]);
      setDeadTimeLoading(false);
      setSelectedDeadTimeSlotId("");
      return;
    }

    let cancelled = false;
    setDeadTimeLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const response: any = await publicListDeadTimeSlots({ market: marketQuery, limit: 200 });
        if (cancelled) return;
        const rawSlots = Array.isArray(response?.data?.slots) ? response.data.slots : [];
        const nextSlots: DeadTimeSlotOption[] = rawSlots
          .map((slot: any) => ({
            slotId: String(slot?.slotId || "").trim(),
            theaterKey: String(slot?.theaterKey || "").trim(),
            theaterName: String(slot?.theaterName || "").trim(),
            market: String(slot?.market || "").trim(),
            dayOfWeek: String(slot?.dayOfWeek || "").trim(),
            timeLabel: String(slot?.timeLabel || "").trim(),
            screeningDateTime: String(slot?.screeningDateTime || "").trim(),
            label: String(slot?.label || "").trim(),
            ticketPrice: sanitizeCurrency(slot?.ticketPrice ?? slot?.ticket_price),
            licensingFee: sanitizeCurrency(slot?.licensingFee ?? slot?.licenseFee ?? slot?.licensing_fee),
          }))
          .filter((slot: DeadTimeSlotOption) => Boolean(slot.slotId));

        setDeadTimeSlots(nextSlots);
        setSelectedDeadTimeSlotId((prev) => {
          if (prev && nextSlots.some((slot) => slot.slotId === prev)) {
            return prev;
          }
          return nextSlots.find((slot) => Boolean(slot.screeningDateTime))?.slotId || "";
        });
      } catch {
        if (!cancelled) {
          setDeadTimeSlots([]);
          setSelectedDeadTimeSlotId("");
        }
      } finally {
        if (!cancelled) setDeadTimeLoading(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [market]);

  const selectedDeadTimeSlot = deadTimeSlots.find((slot) => slot.slotId === selectedDeadTimeSlotId) || null;
  const selectedDeadTimeLabel = selectedDeadTimeSlot?.label || "";

  const theaterOptions = Array.from(
    new Map(
      deadTimeSlots
        .filter((slot) => Boolean(slot.theaterName || slot.theaterKey))
        .map((slot) => [slot.theaterKey || slot.theaterName, { theaterKey: slot.theaterKey, theaterName: slot.theaterName }]),
    ).values(),
  );

  useEffect(() => {
    if (selectedDeadTimeSlot?.theaterName) {
      setSelectedPreferredTheater(selectedDeadTimeSlot.theaterName);
      return;
    }
    if (!theaterOptions.some((row) => row.theaterName === selectedPreferredTheater)) {
      setSelectedPreferredTheater(theaterOptions[0]?.theaterName || "");
    }
  }, [selectedDeadTimeSlotId, selectedDeadTimeSlot?.theaterName, selectedPreferredTheater, theaterOptions]);

  const selectedTheaterSlot =
    deadTimeSlots.find((slot) => slot.theaterName === selectedPreferredTheater && slot.ticketPrice && slot.licensingFee) ||
    deadTimeSlots.find((slot) => slot.theaterName === selectedPreferredTheater) ||
    selectedDeadTimeSlot;

  const thresholdTicketPrice = selectedTheaterSlot?.ticketPrice || null;
  const thresholdLicensingFee = selectedTheaterSlot?.licensingFee || null;
  const autoBackingThreshold = computeAutoBackingThreshold(thresholdTicketPrice, thresholdLicensingFee);

  async function handleSignIn() {
    setErrorMessage("");
    try {
      await signInWithGoogle();
    } catch (error) {
      if (isPopupSignInCancellation(error)) {
        return;
      }
      setErrorMessage(String((error as any)?.message || "Sign-in failed. Please try again."));
    }
  }

  async function handleSignOut() {
    await signOut(auth);
    setSubmitState("idle");
    setSuccessMessage("");
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    const rankedChoices = choices.map((choice) => choice.trim());
    if (rankedChoices.some((choice) => !choice)) {
      setErrorMessage(`Please enter all ${CAMPAIGN_MOVIE_CHOICES_REQUIRED} movie choices.`);
      return;
    }

    const unique = new Set(rankedChoices.map((choice) => choice.toLowerCase()));
    if (unique.size !== CAMPAIGN_MOVIE_CHOICES_REQUIRED) {
      setErrorMessage("Movie choices must be unique.");
      return;
    }

    if (!selectedDeadTimeSlot || !selectedDeadTimeSlotId || !selectedDeadTimeLabel) {
      setErrorMessage("Please select an available day/time screening slot from local theaters.");
      return;
    }

    if (!selectedDeadTimeSlot.screeningDateTime) {
      setErrorMessage("Selected screening slot must include a screening date/time.");
      return;
    }

    setSubmitState("submitting");

    try {
      const response: any = await createCampaign({
        title,
        market,
        dateWindowLabel: selectedDeadTimeLabel,
        deadTimeSlotId: selectedDeadTimeSlotId,
        choices: rankedChoices,
        preferredTheaters: selectedPreferredTheater ? [selectedPreferredTheater] : [],
        backingThreshold: autoBackingThreshold || undefined,
      });

      const campaign = response?.data?.campaign;
      setSubmitState("success");
      setSuccessMessage(
        campaign?.slug
          ? `Campaign created: ${campaign.title}. Slot: ${selectedDeadTimeLabel}. It is now live at /campaigns.`
          : "Campaign created successfully.",
      );

      setTitle("");
      setMarket("");
      setCitySuggestions([]);
      setShowCitySuggestions(false);
      setDeadTimeSlots([]);
      setDeadTimeLoading(false);
      setSelectedDeadTimeSlotId("");
      setChoices(["", "", ""]);
      setMovieSuggestionsByIndex({ 0: [], 1: [], 2: [] });
      setMovieSearchLoadingByIndex({ 0: false, 1: false, 2: false });
      setActiveMovieInputIndex(null);
      setSelectedPreferredTheater("");
    } catch (error) {
      setSubmitState("idle");
      setErrorMessage(String((error as any)?.message || "Could not create campaign."));
    }
  }

  if (authUser === undefined) {
    return <p className="text-sm text-ink-soft">Loading sign-in state…</p>;
  }

  return (
    <form className="mt-10 grid gap-4" onSubmit={handleSubmit}>
      {!authUser ? (
        <div className="rounded-2xl border border-line bg-paper p-6 text-center">
          <p className="text-sm text-ink-soft">Sign in to create a campaign.</p>
          <button
            type="button"
            onClick={handleSignIn}
            className="mt-4 rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5"
          >
            Sign in with Google
          </button>
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-line bg-paper p-4 text-sm text-ink-soft">
            Signed in as <strong className="text-ink">{authUser.email}</strong>
            <button type="button" onClick={handleSignOut} className="ml-3 text-marquee hover:underline">
              Sign out
            </button>
          </div>

          <div className="rounded-2xl border border-line bg-paper p-5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="campaignTitle">
              Campaign title
            </label>
            <input
              id="campaignTitle"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              type="text"
              placeholder="Friday Night Sci-Fi"
              className="mt-2 w-full rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-line bg-paper p-5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="campaignMarket">
                City
              </label>
              <input
                id="campaignMarket"
                required
                value={market}
                onFocus={() => setShowCitySuggestions(true)}
                onBlur={() => window.setTimeout(() => setShowCitySuggestions(false), 120)}
                onChange={(event) => {
                  setMarket(event.target.value);
                  setShowCitySuggestions(true);
                }}
                type="text"
                placeholder="Search city (e.g., Oakland, CA)"
                className="mt-2 w-full rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
              />
              <p className="mt-3 text-xs text-ink-faint">1. Pick your city first.</p>
              {showCitySuggestions && (
                <div className="mt-2 rounded-xl border border-line bg-cream p-2">
                  {citySearchLoading ? (
                    <p className="px-2 py-2 text-xs text-ink-soft">Searching cities…</p>
                  ) : citySuggestions.length > 0 ? (
                    <div className="max-h-44 space-y-1 overflow-y-auto">
                      {citySuggestions.map((city) => (
                        <button
                          key={city}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setMarket(city);
                            setShowCitySuggestions(false);
                          }}
                          className="block w-full rounded-lg px-2 py-2 text-left text-xs text-ink transition-colors hover:bg-paper"
                        >
                          {city}
                        </button>
                      ))}
                    </div>
                  ) : market.trim().length >= 2 ? (
                    <p className="px-2 py-2 text-xs text-ink-soft">No city matches found. You can still type your city manually.</p>
                  ) : (
                    <p className="px-2 py-2 text-xs text-ink-soft">Type at least 2 characters to search cities.</p>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-line bg-paper p-5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="deadTimeSlot">
                Available Days + Times
              </label>
              <select
                id="deadTimeSlot"
                required
                value={selectedDeadTimeSlotId}
                onChange={(event) => setSelectedDeadTimeSlotId(event.target.value)}
                className="mt-2 w-full rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
              >
                {deadTimeLoading ? (
                  <option value="">Loading local theater screening slots…</option>
                ) : deadTimeSlots.filter((slot) => Boolean(slot.screeningDateTime)).length > 0 ? (
                  deadTimeSlots.filter((slot) => Boolean(slot.screeningDateTime)).map((slot) => (
                    <option key={slot.slotId} value={slot.slotId}>
                      {slot.label || `${slot.theaterName} • ${slot.dayOfWeek} ${slot.timeLabel}`}
                    </option>
                  ))
                ) : (
                  <option value="">No screening slots found for this city yet</option>
                )}
              </select>
              <p className="mt-3 text-xs text-ink-faint">
                {selectedDeadTimeSlot ? (
                  <>
                    Campaign slot: <strong className="text-ink">{selectedDeadTimeLabel}</strong>
                  </>
                ) : (
                  <>
                    <span className="block">2. Choose a theater-submitted screening slot with a date/time.</span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Movie choices (initial order)</p>
            <p className="mt-2 text-xs text-ink-faint">Search TMDB and set Choice 1, 2, and 3. Live ranking changes automatically from votes.</p>
            <div className="mt-3 grid gap-3">
              {[0, 1, 2].map((index) => {
                const label = `Choice ${index + 1}`;
                const results = movieSuggestionsByIndex[index] || [];
                const loading = Boolean(movieSearchLoadingByIndex[index]);
                const hasQuery = choices[index].trim().length >= 2;
                return (
                  <div key={label} className="rounded-xl border border-line bg-cream p-3">
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</label>
                    <input
                      required
                      value={choices[index]}
                      onFocus={() => setActiveMovieInputIndex(index)}
                      onChange={(event) => {
                        const next = [...choices];
                        next[index] = event.target.value;
                        setChoices(next);
                        setActiveMovieInputIndex(index);
                      }}
                      type="text"
                      placeholder={`${index + 1}. Search movie title`}
                      className="mt-2 w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
                    />

                    {activeMovieInputIndex === index && (
                      <div className="mt-2 rounded-xl border border-line bg-paper p-2">
                        {loading ? (
                          <p className="px-2 py-2 text-xs text-ink-soft">Searching TMDB…</p>
                        ) : hasQuery && results.length > 0 ? (
                          <div className="max-h-52 space-y-1 overflow-y-auto">
                            {results.map((result) => (
                              <button
                                key={`${result.tmdbId}-${result.releaseDate || ""}`}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  const next = [...choices];
                                  next[index] = result.title;
                                  setChoices(next);
                                  setMovieSuggestionsByIndex((prev) => ({ ...prev, [index]: [] }));
                                  setActiveMovieInputIndex(null);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-cream-soft"
                              >
                                {result.poster ? (
                                  <img src={result.poster} alt="" className="h-10 w-7 shrink-0 rounded object-cover" />
                                ) : (
                                  <div className="h-10 w-7 shrink-0 rounded bg-cream-soft" />
                                )}
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-semibold text-ink">{result.title}</p>
                                  <p className="text-[11px] text-ink-faint">
                                    {result.releaseDate ? result.releaseDate.slice(0, 4) : "Year N/A"}
                                    {result.starRating ? ` · ${result.starRating}` : ""}
                                  </p>
                                </div>
                              </button>
                            ))}
                          </div>
                        ) : hasQuery ? (
                          <p className="px-2 py-2 text-xs text-ink-soft">No TMDB matches yet. Keep typing.</p>
                        ) : (
                          <p className="px-2 py-2 text-xs text-ink-soft">Type at least 2 characters to search.</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-paper p-5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint" htmlFor="preferredTheater">
              Preferred theater
            </label>
            <select
              id="preferredTheater"
              value={selectedPreferredTheater}
              onChange={(event) => setSelectedPreferredTheater(event.target.value)}
              className="mt-2 w-full rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            >
              {theaterOptions.length > 0 ? (
                theaterOptions.map((row) => (
                  <option key={row.theaterKey || row.theaterName} value={row.theaterName}>
                    {row.theaterName}
                  </option>
                ))
              ) : (
                <option value="">No theater options for this city yet</option>
              )}
            </select>
            <p className="mt-2 text-xs text-ink-faint">Options are theaters in this city that currently have screening slots.</p>
          </div>

          <div className="rounded-2xl border border-line bg-paper p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Backing threshold</p>
            {autoBackingThreshold ? (
              <div className="mt-2 space-y-1 text-sm leading-relaxed text-ink-soft">
                <p>
                  Auto threshold for <strong className="text-ink">{selectedPreferredTheater || selectedTheaterSlot?.theaterName || "selected theater"}</strong>: <strong className="text-ink">{autoBackingThreshold} backers</strong>
                </p>
                <p className="text-xs text-ink-faint">
                  Based on estimated ticket price ${thresholdTicketPrice?.toFixed(2)} and licensing fee ${thresholdLicensingFee?.toFixed(2)}.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Threshold will auto-fill when the selected theater has both ticket price and licensing fee saved on its screening slot.
              </p>
            )}
          </div>

          {errorMessage && <p className="rounded-xl border border-red-300/30 bg-red-900/20 p-3 text-sm text-red-200">{errorMessage}</p>}
          {successMessage && <p className="rounded-xl border border-emerald/30 bg-emerald-soft/40 p-3 text-sm text-emerald">{successMessage}</p>}

          <button
            type="submit"
            disabled={submitState === "submitting"}
            className="w-full rounded-full bg-marquee px-7 py-3.5 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitState === "submitting" ? "Creating campaign…" : "Create campaign"}
          </button>
        </>
      )}
    </form>
  );
}
