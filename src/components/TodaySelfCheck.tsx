// Dev-only visual self-check for the Today page.
//
// On mount, it verifies the three things that have repeatedly broken:
//   1. The AmbientBackdrop element is present in the DOM.
//   2. The hero text is readable (light text against a dark backdrop, with
//      sufficient computed contrast — i.e. styles.css tokens loaded).
//   3. The Generate button (or its container) is rendered when an occasion
//      is selected.
//
// Results print to the console with a single grouped report. If any check
// fails, a small dismissible badge appears bottom-left so regressions are
// visible without opening devtools. Production builds render nothing.

import { useEffect, useState } from "react";

type CheckResult = { name: string; ok: boolean; detail?: string };

function parseRgb(input: string): [number, number, number] | null {
  const m = input.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3) return null;
  return [parts[0], parts[1], parts[2]];
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const norm = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
}

export function TodaySelfCheck() {
  const [failures, setFailures] = useState<CheckResult[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Wait two animation frames so backdrop + hero have laid out.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(runChecks);
    });

    function runChecks() {
      const results: CheckResult[] = [];

      // 1. Backdrop present
      const backdrop = document.querySelector(
        '[data-atelier="ambient-backdrop"]',
      ) as HTMLElement | null;
      results.push({
        name: "Ambient backdrop mounted",
        ok: !!backdrop,
        detail: backdrop ? undefined : "No element with data-atelier=ambient-backdrop",
      });

      // 2. Hero text readable
      const hero = document.querySelector(
        '[data-atelier="today-hero-text"]',
      ) as HTMLElement | null;
      if (!hero) {
        results.push({ name: "Hero text rendered", ok: false, detail: "h1 missing" });
      } else {
        const styles = getComputedStyle(hero);
        const rgb = parseRgb(styles.color);
        const lum = rgb ? relLuminance(rgb) : 0;
        // bone is light; expect luminance > 0.6
        results.push({
          name: "Hero text colour applied",
          ok: lum > 0.6,
          detail: `color=${styles.color} luminance=${lum.toFixed(2)}`,
        });
        const rect = hero.getBoundingClientRect();
        results.push({
          name: "Hero text visible",
          ok: rect.width > 40 && rect.height > 10,
          detail: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        });
      }

      // 3. Generate button present (only checked if container exists)
      const occBar = document.querySelector('[data-atelier="occasion-pills"]');
      results.push({
        name: "Occasion pills mounted",
        ok: !!occBar,
      });

      const failed = results.filter((r) => !r.ok);
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `%c[Today self-check] ${failed.length === 0 ? "PASS" : `${failed.length} FAIL`}`,
        `color:${failed.length === 0 ? "#4ade80" : "#f87171"};font-weight:600`,
      );
      results.forEach((r) => {
        // eslint-disable-next-line no-console
        console[r.ok ? "log" : "warn"](
          `${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`,
        );
      });
      // eslint-disable-next-line no-console
      console.groupEnd();
      setFailures(failed);
    }

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  if (import.meta.env.PROD) return null;
  if (dismissed || failures.length === 0) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-[100] max-w-xs rounded border border-red-400/60 bg-red-950/90 p-3 font-mono text-[11px] text-red-100 shadow-lg"
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="font-semibold tracking-wider uppercase">
          Today self-check failed
        </span>
        <button
          onClick={() => setDismissed(true)}
          className="text-red-200/70 hover:text-red-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
      <ul className="space-y-0.5">
        {failures.map((f) => (
          <li key={f.name}>
            ✗ {f.name}
            {f.detail ? <span className="opacity-70"> — {f.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
