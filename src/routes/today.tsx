import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Cloud, Calendar } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ThreeLooksSheet } from "@/components/ThreeLooksSheet";
import {
  CustomOccasionModal,
  type CustomOccasionInput,
} from "@/components/CustomOccasionModal";
import { AmbientBackdrop } from "@/components/AmbientBackdrop";
import { TodaySelfCheck } from "@/components/TodaySelfCheck";
import { useAuth } from "@/lib/auth";
import { useUI, useThreeLooksSheet, useStylerSession, type Mood } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { type Occasion } from "@/lib/mock-ai";
import { suggestOutfit } from "@/lib/suggestOutfit.functions";
import { generateDailyPrompt } from "@/lib/generateDailyPrompt.functions";
import { markInstallPromptReady } from "@/components/InstallPrompt";

const ALL_OCC_IDS = ["office", "casual", "evening", "athletic", "formal", "travel"] as const;

export const Route = createFileRoute("/today")({
  component: () => (
    <ProtectedRoute>
      <TodayPage />
    </ProtectedRoute>
  ),
  validateSearch: (
    search: Record<string, unknown>,
  ): { occasion?: Occasion; batch?: string; custom?: string; note?: string } => {
    const occ = search.occasion;
    const batch = search.batch;
    const custom = search.custom;
    const note = search.note;
    return {
      occasion:
        typeof occ === "string" && (ALL_OCC_IDS as readonly string[]).includes(occ)
          ? (occ as Occasion)
          : undefined,
      batch: typeof batch === "string" && batch.length > 0 ? batch : undefined,
      custom:
        typeof custom === "string" && custom.length > 0
          ? custom.slice(0, 80)
          : undefined,
      note:
        typeof note === "string" && note.length > 0 ? note.slice(0, 400) : undefined,
    };
  },
  head: () => ({ meta: [{ title: "Today — Atelier" }] }),
});

/**
 * Heuristic mapping of free-text occasion/notes to one of the six presets.
 * Used to pick a formality band when the user types their own occasion.
 * The full free-text is still sent to the AI so the look reflects the
 * specifics — this is just a coarse filter for which wardrobe items qualify.
 */
function mapTextToOccasion(text: string): Occasion {
  const t = text.toLowerCase();
  // Formal: weddings (as guest), galas, black-tie, funerals, ceremonies.
  if (/\b(wedding|gala|black[- ]?tie|funeral|ceremony|cocktail|opera)\b/.test(t)) {
    return "formal";
  }
  // Athletic: gym, run, hike, sport, yoga.
  if (/\b(gym|run(ning)?|hike|hiking|workout|yoga|sport|pilates|tennis|climb)\b/.test(t)) {
    return "athletic";
  }
  // Travel: flight, airport, train, road trip.
  if (/\b(flight|airport|plane|train|road ?trip|travel(ling|ing)?|transit)\b/.test(t)) {
    return "travel";
  }
  // Evening: dinner, date, drinks, party, night out, bar, concert.
  if (/\b(dinner|date|drinks?|party|night out|bar|club|concert|theatre|theater|launch|opening)\b/.test(t)) {
    return "evening";
  }
  // Office: interview, meeting, client, presentation, work, office, board, conference.
  if (/\b(interview|meeting|client|presentation|work|office|board|conference|pitch|standup|stand[- ]up)\b/.test(t)) {
    return "office";
  }
  // Default: casual.
  return "casual";
}

const PRIMARY_OCCASIONS: { id: Occasion; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "casual", label: "Casual" },
  { id: "evening", label: "Evening" },
];

const ALL_OCCASIONS: { id: Occasion; label: string }[] = [
  { id: "office", label: "Office" },
  { id: "casual", label: "Casual" },
  { id: "evening", label: "Evening" },
  { id: "athletic", label: "Athletic" },
  { id: "formal", label: "Formal" },
  { id: "travel", label: "Travel" },
];

function TodayPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const {
    occasion: urlOccasion,
    batch: urlBatch,
    custom: urlCustom,
    note: urlNote,
  } = Route.useSearch();
  const { mood, setMood } = useUI();
  const [moreOpen, setMoreOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const selected = urlOccasion ?? null;
  const hasCustom = !!urlCustom;
  const [generating, setGenerating] = useState(false);
  const [shake, setShake] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  // Global sheet state — also opened from Recent Looks cards and deep links.
  const sheetOpen = useThreeLooksSheet((s) => s.isOpen);
  const activeBatch = useThreeLooksSheet((s) => s.batchId);
  const openSheet = useThreeLooksSheet((s) => s.open);
  const setBatchId = useThreeLooksSheet((s) => s.setBatchId);
  const closeSheetStore = useThreeLooksSheet((s) => s.close);

  // Deep-link: if URL has ?batch=… open the sheet with it.
  useEffect(() => {
    if (urlBatch) {
      openSheet(urlBatch);
    }
  }, [urlBatch, openSheet]);

  const closeSheet = useCallback(() => {
    closeSheetStore();
    // Only strip the ?batch= param if we're still on /today. If the user is
    // navigating away (e.g. clicking Details to /outfit/$id), the route is
    // already changing and a competing replace-navigate can hijack it.
    if (urlBatch && window.location.pathname === "/today") {
      navigate({
        to: "/today",
        search: { occasion: urlOccasion, custom: urlCustom, note: urlNote },
        replace: true,
      });
    }
  }, [closeSheetStore, urlBatch, urlOccasion, urlCustom, urlNote, navigate]);

  const today = useMemo(() => new Date(), []);
  const dateLabel = useMemo(
    () =>
      today
        .toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short" })
        .toUpperCase()
        .replace(",", " ·"),
    [today],
  );
  const dayName = today.toLocaleDateString("en-US", { weekday: "long" });

  // Daily prompt — server function caches per user/day; geolocation optional.
  const promptQuery = useQuery({
    queryKey: ["daily-prompt", user?.id, today.toDateString()],
    enabled: !!user,
    queryFn: async () => {
      // Best-effort browser geolocation. Time out fast and ignore errors —
      // the server falls back to neutral defaults.
      const coords = await new Promise<{ lat: number; lon: number } | null>(
        (resolve) => {
          if (typeof navigator === "undefined" || !navigator.geolocation) {
            resolve(null);
            return;
          }
          const timer = setTimeout(() => resolve(null), 2500);
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              clearTimeout(timer);
              resolve({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
              });
            },
            () => {
              clearTimeout(timer);
              resolve(null);
            },
            { timeout: 2000, maximumAge: 60 * 60 * 1000 },
          );
        },
      );

      const result = await generateDailyPrompt({
        data: coords ?? {},
      });

      if ("error" in result) {
        // Soft-fail: return a neutral prompt object rather than break the page
        return {
          id: "fallback",
          user_id: user!.id,
          prompt_date: today.toISOString().slice(0, 10),
          prompt_text: "Today, choose less. Then choose well.",
          context: { fallback: true, reason: result.error },
        };
      }
      return result.prompt;
    },
  });

  // Recent looks rail removed — Today is single-viewport. Saved tab is
  // where outfit history lives.

  // Wardrobe for occasion gating + generation
  const wardrobeQuery = useQuery({
    queryKey: ["wardrobe-count", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("wardrobe_items")
        .select("id, formality_score, category, subcategory")
        .eq("user_id", user!.id)
        .eq("archived", false);
      return data ?? [];
    },
  });

  // Keep in sync with FORMALITY_RANGE on the server (suggestOutfit.ts).
  const occasionViable = (occ: Occasion) => {
    const items = wardrobeQuery.data ?? [];
    const ranges: Record<Occasion, [number, number]> = {
      office: [5, 10],
      casual: [1, 7],
      evening: [6, 10],
      athletic: [1, 4],
      formal: [8, 10],
      travel: [2, 8],
    };
    const [lo, hi] = ranges[occ];
    return (
      items.filter(
        (i) => i.formality_score && i.formality_score >= lo && i.formality_score <= hi,
      ).length >= 3
    );
  };

  function setSelected(occ: Occasion | null) {
    navigate({
      to: "/today",
      // Picking a preset clears any free-text occasion.
      search: { occasion: occ ?? undefined },
      replace: true,
    });
  }

  function togglePill(id: Occasion) {
    setSelected(selected === id ? null : id);
  }

  function applyCustomOccasion(input: { custom: string; note: string }) {
    const text = `${input.custom} ${input.note}`.trim();
    const mapped = mapTextToOccasion(text || input.custom);
    navigate({
      to: "/today",
      search: {
        occasion: mapped,
        custom: input.custom.trim().slice(0, 80) || undefined,
        note: input.note.trim().slice(0, 400) || undefined,
      },
      replace: true,
    });
  }

  function clearCustomOccasion() {
    navigate({
      to: "/today",
      search: { occasion: undefined },
      replace: true,
    });
  }

  async function handleGenerate() {
    if (!selected || !user || generating) return;
    setGenerating(true);
    setLastError(null);
    try {
      const wardrobe = wardrobeQuery.data ?? [];
      if (wardrobe.length < 3) {
        toast("Add at least 3 pieces to compose looks.");
        return;
      }

      // Look up the most recent batch for this occasion so the server can
      // explicitly avoid repeating it.
      const { data: lastBatch } = await supabase
        .from("outfits")
        .select("batch_id")
        .eq("user_id", user.id)
        .eq("occasion", selected)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const recentBatchIds = useStylerSession.getState().recentBatchIds;
      const result = await suggestOutfit({
        data: {
          occasion: selected,
          temp_c: 14,
          mood,
          custom_occasion: urlCustom,
          note: urlNote,
          exclude_batch_id: lastBatch?.batch_id ?? undefined,
          exclude_recent_batch_ids: recentBatchIds.length > 0 ? recentBatchIds : undefined,
        },
      });

      if ("error" in result) {
        console.warn("[suggestOutfit] error result:", result);
        let errMsg = "Something went wrong. Try again.";
        switch (result.error) {
          case "rate_limited":
            errMsg = "Daily limit reached. Try again after midnight.";
            break;
          case "insufficient_wardrobe":
            errMsg = "Add at least 5 items to compose looks.";
            break;
          case "insufficient_for_occasion": {
            const what = (result.missing ?? []).join(", ") || "items";
            errMsg = `Add ${what} to compose ${selected} looks.`;
            break;
          }
          case "composition_failed": {
            const reasons = "reasons" in result && Array.isArray(result.reasons)
              ? result.reasons
              : [];
            if (reasons.includes("formality_variance")) {
              errMsg =
                "Wardrobe has very mixed formality. Add a piece around 6–7 formality.";
            } else if (reasons.includes("hallucinated_id")) {
              errMsg = "AI returned invalid items. Try again.";
            } else {
              errMsg = result.message ?? "Couldn't compose a look. Try again.";
            }
            break;
          }
          case "unexpected":
            errMsg = `Compose failed: ${
              ("message" in result && result.message) || "unknown error"
            }`;
            break;
        }
        toast(errMsg);
        setLastError(errMsg);
        setShake((s) => s + 1);
        return;
      }

      // First successful generation → arm the install prompt strip.
      markInstallPromptReady();

      // Inspiration disabled — Style DNA picker replaces it (planned).

      useStylerSession.getState().pushBatch(result.batch_id);
      openSheet(result.batch_id);
    } catch (e) {
      console.error("[handleGenerate] threw:", e);
      setShake((s) => s + 1);
      const msg = e instanceof Error ? e.message : String(e);
      const errMsg = `Couldn't compose looks: ${msg.slice(0, 100)}`;
      toast(errMsg);
      setLastError(errMsg);
    } finally {
      setGenerating(false);
    }
  }

  const promptText = promptQuery.data?.prompt_text ?? "";
  const words = promptText.split(" ");

  return (
    <Shell>
      <AmbientBackdrop />
      <TodaySelfCheck />
      {/* Hero */}
      <section className="relative z-10 flex min-h-[calc(100vh-64px)] flex-col items-center justify-center px-6">
        <div className="w-full max-w-[680px]">
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: dur.hover, ease: ease.luxury }}
            className="font-mono text-[11px] uppercase tracking-[0.2em] text-bone/70"
          >
            {dateLabel}
          </motion.p>

          <h1
            data-atelier="today-hero-text"
            className="mt-8 font-display text-[36px] font-light leading-[1.1] text-bone"
          >
            {promptQuery.isLoading || !promptText ? (
              <span className="inline-block h-[1.1em] w-[80%] atelier-shimmer" />
            ) : (
              words.map((w, i) => (
                <motion.span
                  key={`${w}-${i}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.52,
                    delay: i * 0.06,
                    ease: ease.luxury,
                  }}
                  className="mr-[0.25em] inline-block"
                >
                  {w}
                </motion.span>
              ))
            )}
          </h1>

          {/* Occasion pills (selectable) */}
          <motion.div
            data-atelier="occasion-pills"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.9, duration: dur.hover }}
            className="mt-12 flex flex-wrap items-center gap-3"
          >
            {PRIMARY_OCCASIONS.map(({ id, label }) => {
              const viable =
                (wardrobeQuery.data?.length ?? 0) === 0 || occasionViable(id);
              const isSelected = selected === id;
              const isDimmed = selected !== null && !isSelected;
              return (
                <motion.button
                  key={id}
                  {...tap}
                  disabled={!viable || generating}
                  onClick={() => togglePill(id)}
                  title={
                    !viable
                      ? `Add more pieces to unlock ${label.toLowerCase()} looks.`
                      : undefined
                  }
                  animate={{ opacity: isDimmed ? 0.5 : 1 }}
                  transition={{ duration: 0.22, ease: ease.tactile }}
                  className={`group h-10 rounded-full border border-bone/60 px-6 text-[15px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isSelected
                      ? "bg-bone text-graphite"
                      : "text-bone hover:bg-bone hover:text-graphite"
                  }`}
                  style={{
                    transitionDuration: "220ms",
                    transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
                  }}
                >
                  {label}
                </motion.button>
              );
            })}
            <button
              onClick={() => setMoreOpen(true)}
              className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-bone/70 transition-colors hover:text-bone"
            >
              More occasions →
            </button>
            <button
              onClick={() => setCustomOpen(true)}
              className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone/70 transition-colors hover:text-bone"
            >
              + Custom
            </button>
          </motion.div>

          {/* Active custom occasion chip — clearable */}
          {hasCustom && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.32, ease: ease.luxury }}
              className="mt-4 flex items-start gap-3 rounded border border-bone/40 bg-bone/5 px-4 py-3"
            >
              <div className="flex-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone/60">
                  For {selected}
                </p>
                <p className="mt-1 font-display text-[15px] text-bone">
                  {urlCustom}
                </p>
                {urlNote && (
                  <p className="mt-1 text-[12px] leading-relaxed text-bone/70">
                    {urlNote}
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  setCustomOpen(true);
                }}
                className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone/70 hover:text-bone"
              >
                Edit
              </button>
              <button
                onClick={clearCustomOccasion}
                aria-label="Clear custom occasion"
                className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone/50 hover:text-bone"
              >
                ×
              </button>
            </motion.div>
          )}

          {/* Generate button — appears only when an occasion is selected */}
          <AnimatePresence>
            {selected && (
              <motion.div
                key="generate"
                data-atelier="generate-button-wrap"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.32, ease: ease.luxury, delay: 0.12 }}
                className="mt-10 flex flex-col items-center"
              >
                <motion.button
                  key={shake}
                  onClick={handleGenerate}
                  disabled={generating}
                  data-atelier="generate-button"
                  data-state={
                    generating ? "loading" : lastError ? "error" : "idle"
                  }
                  aria-busy={generating}
                  aria-live="polite"
                  animate={
                    shake > 0
                      ? { x: [-4, 4, -4, 4, 0] }
                      : { scale: 1 }
                  }
                  transition={{ duration: 0.4, ease: ease.tactile }}
                  whileTap={{ scale: 0.98 }}
                  className={`relative h-14 w-full max-w-[360px] transition-colors disabled:cursor-wait ${
                    lastError && !generating
                      ? "bg-red-100 text-red-900 hover:bg-red-200"
                      : "bg-bone text-graphite hover:bg-bone/90"
                  } disabled:opacity-90`}
                  style={{
                    fontFamily: "var(--font-display, Fraunces), serif",
                    fontSize: "17px",
                    letterSpacing: "0.04em",
                  }}
                >
                  {generating ? (
                    <span className="inline-flex items-center gap-3">
                      <DriftDots />
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
                        Composing…
                      </span>
                    </span>
                  ) : lastError ? (
                    "Try again"
                  ) : (
                    "Generate three looks"
                  )}
                </motion.button>

                {/* Inline error message — visible without needing to catch the
                    toast. Cleared on the next attempt. */}
                <AnimatePresence>
                  {lastError && !generating && (
                    <motion.p
                      key="generate-error"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.24, ease: ease.tactile }}
                      role="alert"
                      className="mt-3 max-w-[360px] text-center font-mono text-[11px] uppercase tracking-[0.14em] text-red-200"
                    >
                      {lastError}
                    </motion.p>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {(wardrobeQuery.data?.length ?? 0) === 0 && (
            <p className="mt-6 text-[14px] text-bone/80">
              Your wardrobe is empty.{" "}
              <button
                onClick={() => navigate({ to: "/wardrobe" })}
                className="border-b border-bone text-bone"
              >
                Add a piece
              </button>{" "}
              to begin.
            </p>
          )}
        </div>
      </section>

      {/* Context strip */}
      <section className="relative z-10 border-y border-bone/20">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: dur.hover }}
          className="mx-auto flex h-14 max-w-[1280px] items-stretch px-6"
        >
          <Cell icon={<Cloud className="h-4 w-4" strokeWidth={1.25} />} label="14° Overcast" />
          <Cell icon={<Calendar className="h-4 w-4" strokeWidth={1.25} />} label="No events" />
          <div className="flex flex-1 items-center justify-center gap-1 border-l border-bone/20">
            {(["sharp", "easy", "playful"] as Mood[]).map((m) => (
              <button
                key={m}
                onClick={() => setMood(m)}
                className={`h-7 px-3 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors ${
                  mood === m ? "bg-bone text-graphite" : "text-bone/70 hover:text-bone"
                }`}
                style={{ borderRadius: "2px" }}
              >
                {m}
              </button>
            ))}
          </div>
        </motion.div>
      </section>

      {/* Recent looks rail removed — Saved tab houses outfit history. */}

      {/* More occasions modal */}
      {moreOpen && (
        <MoreOccasionsModal
          currentSelected={selected}
          onClose={() => setMoreOpen(false)}
          onPick={(occ) => {
            setMoreOpen(false);
            setSelected(occ);
          }}
        />
      )}

      {/* Custom occasion modal */}
      {customOpen && (
        <CustomOccasionModal
          initialCustom={urlCustom ?? ""}
          initialNote={urlNote ?? ""}
          onClose={() => setCustomOpen(false)}
          onApply={(input: CustomOccasionInput) => {
            setCustomOpen(false);
            applyCustomOccasion(input);
          }}
        />
      )}

      {/* Three Looks bottom sheet */}
      <ThreeLooksSheet
        open={sheetOpen}
        batchId={activeBatch}
        onClose={closeSheet}
        onBatchChanged={(b) => setBatchId(b)}
      />
    </Shell>
  );
}

function Cell({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 border-l border-bone/20 first:border-l-0">
      <span className="text-bone/80">{icon}</span>
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone/80">
        {label}
      </span>
    </div>
  );
}

function DriftDots() {
  return (
    <span className="inline-flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1.5 w-1.5 rounded-full bg-graphite"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.16,
            ease: ease.drift,
          }}
        />
      ))}
    </span>
  );
}

function MoreOccasionsModal({
  currentSelected,
  onClose,
  onPick,
}: {
  currentSelected: Occasion | null;
  onClose: () => void;
  onPick: (o: Occasion) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: dur.hover, ease: ease.tactile }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite/40 px-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] bg-bone p-12"
        style={{ boxShadow: "0 20px 60px -20px rgba(0,0,0,0.25)", borderRadius: "2px" }}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Choose occasion
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          {ALL_OCCASIONS.map(({ id, label }) => {
            const isSelected = currentSelected === id;
            return (
              <motion.button
                key={id}
                {...tap}
                onClick={() => onPick(id)}
                className={`h-12 border border-ink text-[14px] transition-colors ${
                  isSelected
                    ? "bg-graphite text-bone"
                    : "text-graphite hover:bg-graphite hover:text-bone"
                }`}
              >
                {label}
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}
