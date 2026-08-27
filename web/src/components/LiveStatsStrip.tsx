import { useEffect, useRef, useState } from "react";
import { collection, getCountFromServer, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";

interface Stat {
  label: string;
  value: number;
}

function useCountUp(target: number, active: boolean, durationMs = 900) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (!active) return;
    let frame: number;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(eased * target));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, target, durationMs]);

  return displayValue;
}

function StatNumber({ label, value, active }: { label: string; value: number; active: boolean }) {
  const displayValue = useCountUp(value, active);
  return (
    <div className="text-center">
      <p className="font-display text-4xl font-semibold text-ink sm:text-5xl">{displayValue.toLocaleString()}</p>
      <p className="mt-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint sm:text-sm">{label}</p>
    </div>
  );
}

// Two real, live-queried counts (Firestore aggregate count() — cheap, no
// document reads) — not placeholder/fake stats. Animates in once scrolled
// into view.
export default function LiveStatsStrip() {
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [screeningsCount, endedCount] = await Promise.all([
          getCountFromServer(collection(db, "events")),
          getCountFromServer(query(collection(db, "events"), where("voteStatus", "==", "ended"))),
        ]);

        if (cancelled) return;
        setStats([
          { label: "Screenings hosted", value: screeningsCount.data().count },
          { label: "Community votes completed", value: endedCount.data().count },
        ]);
      } catch (error) {
        console.error("[LiveStatsStrip] Could not load stats:", error);
        if (!cancelled) setStats([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (stats !== null && stats.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-4">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald" />
        </span>
        Live from ReelVotes
      </span>
      <div ref={containerRef} className="flex items-center justify-center gap-10 sm:gap-16">
        {stats === null
        ? Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="text-center">
              <div className="mx-auto h-10 w-16 animate-pulse rounded bg-cream-soft sm:h-12 sm:w-20" />
              <div className="mx-auto mt-2.5 h-3 w-24 animate-pulse rounded bg-cream-soft" />
            </div>
          ))
        : stats.map((stat) => <StatNumber key={stat.label} label={stat.label} value={stat.value} active={visible} />)}
      </div>
    </div>
  );
}
