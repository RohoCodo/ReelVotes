import { useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { createCampaign } from "../lib/firebase";
import { auth, isPopupSignInCancellation, onAuthStateChanged, signInWithGoogle, signOut } from "../lib/firebase-auth";
import { CAMPAIGN_MOVIE_CHOICES_REQUIRED } from "../lib/campaign-policy";
import { searchMoviesByQuery, type MovieSearchResult } from "../lib/tmdb";
import { publicListTheaters } from "../lib/firebase-core";

type TheaterOption = {
  theaterKey: string;
  theaterName: string;
  theaterCityState: string;
};

type SubmitState = "idle" | "submitting" | "success";

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isAtLeastTwoWeekRange(range: DateRange | undefined): boolean {
  if (!range?.from || !range?.to) return false;
  const start = new Date(range.from.getFullYear(), range.from.getMonth(), range.from.getDate());
  const end = new Date(range.to.getFullYear(), range.to.getMonth(), range.to.getDate());
  const msInDay = 24 * 60 * 60 * 1000;
  const dayCount = Math.floor((end.getTime() - start.getTime()) / msInDay) + 1;
  return dayCount >= 14;
}

function formatRangeLabel(range: DateRange | undefined): string {
  if (!range?.from || !range?.to) return "Choose 2-week window";
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return `${formatter.format(range.from)} - ${formatter.format(range.to)}`;
}

export default function CreateCampaignForm() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [market, setMarket] = useState("");
  const [citySuggestions, setCitySuggestions] = useState<string[]>([]);
  const [citySearchLoading, setCitySearchLoading] = useState(false);
  const [showCitySuggestions, setShowCitySuggestions] = useState(false);
  const [selectedRange, setSelectedRange] = useState<DateRange | undefined>(undefined);
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
  const [preferredTheaterOptions, setPreferredTheaterOptions] = useState<TheaterOption[]>([]);
  const [preferredTheaterLoading, setPreferredTheaterLoading] = useState(false);

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
        const response: any = await publicListTheaters({ query, limit: 60 });
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
    const marketQuery = market.trim();
    if (marketQuery.length < 2) {
      setPreferredTheaterOptions([]);
      setPreferredTheaterLoading(false);
      return;
    }

    let cancelled = false;
    setPreferredTheaterLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const response: any = await publicListTheaters({ query: marketQuery, limit: 250 });
        if (cancelled) return;

        const theaterRows = Array.isArray(response?.data?.theaters) ? response.data.theaters : [];
        const normalizedMarket = marketQuery.toLowerCase().replace(/\s+/g, " ").trim();
        const normalizedCity = marketQuery.split(",")[0].toLowerCase().trim();
        const deduped = new Map<string, TheaterOption>();

        theaterRows.forEach((row: any) => {
          const theaterKey = String(row?.theater_key || "").trim();
          const theaterName = String(row?.theater_name || "").trim();
          const theaterCityState = String(row?.theater_city_state || "").trim();
          const city = String(row?.city || "").toLowerCase().trim();
          const cityStateLower = theaterCityState.toLowerCase();

          if (!theaterName) return;

          const cityMatch =
            (normalizedMarket && cityStateLower.includes(normalizedMarket)) ||
            (normalizedCity && city.includes(normalizedCity)) ||
            (normalizedCity && cityStateLower.includes(normalizedCity));

          if (!cityMatch) return;

          const key = theaterKey || `${theaterName}|${theaterCityState}`;
          if (!deduped.has(key)) {
            deduped.set(key, { theaterKey, theaterName, theaterCityState });
          }
        });

        const options = Array.from(deduped.values()).sort((a, b) => {
          const citySort = a.theaterCityState.localeCompare(b.theaterCityState);
          if (citySort !== 0) return citySort;
          return a.theaterName.localeCompare(b.theaterName);
        });

        setPreferredTheaterOptions(options);
      } catch {
        if (!cancelled) {
          setPreferredTheaterOptions([]);
        }
      } finally {
        if (!cancelled) setPreferredTheaterLoading(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [market]);

  useEffect(() => {
    if (!selectedPreferredTheater) return;
    if (!preferredTheaterOptions.some((row) => row.theaterName === selectedPreferredTheater)) {
      setSelectedPreferredTheater("");
    }
  }, [preferredTheaterOptions, selectedPreferredTheater]);

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

    if (!selectedRange?.from || !selectedRange?.to) {
      setErrorMessage("Please choose a campaign date window.");
      return;
    }

    if (!isAtLeastTwoWeekRange(selectedRange)) {
      setErrorMessage("Screening window must be at least 2 weeks.");
      return;
    }

    setSubmitState("submitting");

    try {
      const dateRangeStart = toDateKey(selectedRange.from);
      const dateRangeEnd = toDateKey(selectedRange.to);
      const response: any = await createCampaign({
        title,
        market,
        dateWindowLabel: formatRangeLabel(selectedRange),
        dateRangeStart,
        dateRangeEnd,
        choices: rankedChoices,
        preferredTheaters: selectedPreferredTheater ? [selectedPreferredTheater] : [],
      });

      const campaign = response?.data?.campaign;
      setSubmitState("success");
      setSuccessMessage(
        campaign?.slug
          ? `Campaign created: ${campaign.title}. Date window: ${formatRangeLabel(selectedRange)}. It is now live at /campaigns.`
          : "Campaign created successfully.",
      );

      setTitle("");
      setMarket("");
      setCitySuggestions([]);
      setShowCitySuggestions(false);
      setSelectedRange(undefined);
      setChoices(["", "", ""]);
      setMovieSuggestionsByIndex({ 0: [], 1: [], 2: [] });
      setMovieSearchLoadingByIndex({ 0: false, 1: false, 2: false });
      setActiveMovieInputIndex(null);
      setSelectedPreferredTheater("");
      setPreferredTheaterOptions([]);
      setPreferredTheaterLoading(false);
    } catch (error) {
      setSubmitState("idle");
      setErrorMessage(String((error as any)?.message || "Could not create campaign."));
    }
  }

  if (authUser === undefined) {
    return <p className="text-sm text-ink-soft">Loading sign-in state...</p>;
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

          <div className="grid gap-4">
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
                    <p className="px-2 py-2 text-xs text-ink-soft">Searching cities...</p>
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
              <p className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">Screening date window</p>
              <p className="mt-2 text-xs text-ink-faint">2. Pick a date range of at least 2 weeks for when the screening can take place.</p>
              <div className="mt-3 rounded-xl border border-line bg-cream p-3">
                <p className="mb-2 text-xs font-semibold text-ink">{formatRangeLabel(selectedRange)}</p>
                <DayPicker
                  mode="range"
                  selected={selectedRange}
                  onSelect={setSelectedRange}
                  numberOfMonths={2}
                  pagedNavigation
                  showOutsideDays
                  className="rv-date-picker rv-date-picker-two-months text-sm"
                />
              </div>
              {!selectedRange?.from || !selectedRange?.to ? (
                <p className="mt-2 text-xs text-ink-faint">Select both start and end dates.</p>
              ) : isAtLeastTwoWeekRange(selectedRange) ? (
                <p className="mt-2 text-xs text-emerald">Perfect: this screening window is at least 2 weeks.</p>
              ) : (
                <p className="mt-2 text-xs text-red-300">Selected screening range is too short. Please choose at least 2 weeks.</p>
              )}
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
                          <p className="px-2 py-2 text-xs text-ink-soft">Searching movies...</p>
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
                          <p className="px-2 py-2 text-xs text-ink-soft">No matches yet. Keep typing.</p>
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
              Preferred theater (optional)
            </label>
            <select
              id="preferredTheater"
              value={selectedPreferredTheater}
              onChange={(event) => setSelectedPreferredTheater(event.target.value)}
              className="rv-select-inset-arrow mt-2 w-full rounded-xl border border-line bg-cream px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            >
              <option value="">No preference</option>
              {preferredTheaterLoading ? (
                <option value="" disabled>Loading theaters for this city...</option>
              ) : preferredTheaterOptions.length > 0 ? (
                preferredTheaterOptions.map((row) => (
                  <option key={row.theaterKey || `${row.theaterName}|${row.theaterCityState}`} value={row.theaterName}>
                    {row.theaterName}{row.theaterCityState ? ` (${row.theaterCityState})` : ""}
                  </option>
                ))
              ) : (
                <option value="" disabled>No ReelSuccess theaters found for this city</option>
              )}
            </select>
            <p className="mt-2 text-xs text-ink-faint">Results are filtered by the city typed above using ReelSuccess theater data.</p>
          </div>

          {errorMessage && <p className="rounded-xl border border-red-300/30 bg-red-900/20 p-3 text-sm text-red-200">{errorMessage}</p>}
          {successMessage && <p className="rounded-xl border border-emerald/30 bg-emerald-soft/40 p-3 text-sm text-emerald">{successMessage}</p>}

          <button
            type="submit"
            disabled={submitState === "submitting"}
            className="w-full rounded-full bg-marquee px-7 py-3.5 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitState === "submitting" ? "Creating campaign..." : "Create campaign"}
          </button>
        </>
      )}
    </form>
  );
}
