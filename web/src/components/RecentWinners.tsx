import { useEffect, useState } from "react";
import { getRecentWinners, type WinnerCard } from "../lib/recentWinners";

// Fetches the most recent *ended* screenings and shows the winning movie's
// poster for each — real, live results, not placeholder content. Shares a
// cached fetch (src/lib/recentWinners.ts) with the hero's decorative poster
// cluster so the two don't duplicate the same Firestore/TMDB calls.
export default function RecentWinners() {
  const [winners, setWinners] = useState<WinnerCard[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecentWinners().then((results) => {
      if (!cancelled) setWinners(results);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (winners !== null && winners.length === 0) return null;

  return (
    <section className="border-t border-line bg-paper">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-marquee">Real votes, real winners</p>
          <h2 className="mt-3 font-display text-3xl font-semibold text-ink sm:text-4xl">Picked by the audience</h2>
          <p className="mt-4 text-base leading-relaxed text-ink-soft">
            These movies didn't just win a poll — they filled seats. Every poster below is a screening the
            community actually voted into a theater.
          </p>
        </div>

        <div className="mt-12 -mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8">
          {winners === null
            ? Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="w-36 shrink-0 snap-start sm:w-44">
                  <div className="skeleton aspect-[2/3] w-full rounded-xl" />
                  <div className="skeleton mt-2.5 h-3.5 w-4/5 rounded" />
                </div>
              ))
            : winners.map((winner) => (
                <a
                  key={winner.eventId}
                  href={`/vote?event=${encodeURIComponent(winner.eventId)}`}
                  className="group w-36 shrink-0 snap-start sm:w-44"
                >
                  <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-cream-soft shadow-sm transition-transform duration-300 group-hover:-translate-y-1.5 group-hover:shadow-lg">
                    {winner.poster ? (
                      <img
                        src={winner.poster}
                        alt={`${winner.movieTitle} poster`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center bg-gradient-to-br from-marquee-soft to-cream-soft px-3 text-center text-xs font-semibold text-marquee">
                        {winner.movieTitle}
                      </div>
                    )}
                    <span className="absolute left-2 top-2 rounded-full bg-ink/80 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                      Winner
                    </span>
                  </div>
                  <p className="mt-2.5 truncate text-sm font-semibold text-ink">{winner.movieTitle}</p>
                  <p className="truncate text-xs text-ink-faint">{winner.theaterName}</p>
                </a>
              ))}
        </div>
      </div>
    </section>
  );
}
