import { Link, useLocation } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { Sun, Shirt, Bookmark } from "lucide-react";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { ease, dur } from "@/lib/motion";
import { warmBgRemoval } from "@/lib/bg-removal";
import type { ReactNode } from "react";

const NAV = [
  { to: "/today", label: "Today", icon: Sun },
  { to: "/wardrobe", label: "Wardrobe", icon: Shirt },
  { to: "/saved", label: "Saved", icon: Bookmark },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { pathname } = useLocation();

  // Pre-warm the background-removal model in the background so the user's
  // first wardrobe upload doesn't have to wait for the ~15MB download.
  useEffect(() => {
    if (!user) return;
    void warmBgRemoval();
  }, [user]);

  // On the Today route we let the AmbientBackdrop show through. Everywhere
  // else we keep the bone background painted at the shell level so pages with
  // light content (Wardrobe, Saved, Settings) read correctly.
  const isToday = pathname.startsWith("/today");

  return (
    <div className={`min-h-screen text-graphite ${isToday ? "" : "bg-bone"}`}>
      {/* Top bar */}
      <header
        className={`sticky top-0 z-40 h-16 border-b backdrop-blur ${
          isToday
            ? "border-bone/20 bg-noir/40 text-bone"
            : "border-linen bg-bone/95"
        }`}
      >
        <div className="mx-auto flex h-full max-w-[1280px] items-center justify-between px-6">
          <Link
            to="/today"
            className={`font-display text-[20px] font-normal tracking-tight ${
              isToday ? "text-bone" : "text-graphite"
            }`}
            aria-label="Atelier home"
          >
            Atelier
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-12" aria-label="Primary">
            {NAV.map(({ to, label }) => {
              const active = pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  className="group relative text-[13px] tracking-wide text-ink transition-colors hover:text-graphite"
                >
                  <span className={active ? "text-graphite" : ""}>{label}</span>
                  <span
                    className="absolute -bottom-2 left-0 right-0 mx-auto h-px origin-center bg-graphite transition-transform"
                    style={{
                      transform: active ? "scaleX(1)" : "scaleX(0)",
                      transitionDuration: "220ms",
                      transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
                    }}
                  />
                </Link>
              );
            })}
          </nav>

          {/* Avatar */}
          <Link
            to="/settings"
            className={`flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-medium transition-colors ${
              isToday
                ? "border-bone/60 text-bone hover:border-bone hover:text-bone"
                : "border-ink text-ink hover:border-graphite hover:text-graphite"
            }`}
            aria-label="Settings"
          >
            {user?.email?.[0].toUpperCase() ?? "A"}
          </Link>
        </div>
      </header>

      {/* Main */}
      <motion.main
        key={pathname}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -12 }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        className="pb-24"
      >
        {children}
      </motion.main>

      {/* Mobile tab bar */}
      <nav
        className={`fixed bottom-0 left-0 right-0 z-40 flex h-16 items-stretch border-t backdrop-blur ${
          isToday ? "border-bone/20 bg-noir/40" : "border-linen bg-bone/95"
        }`}
        aria-label="Primary mobile"
      >
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = pathname.startsWith(to);
          const activeColor = isToday ? "var(--bone)" : "var(--graphite)";
          const inactiveColor = isToday
            ? "color-mix(in oklab, var(--bone) 65%, transparent)"
            : "var(--ink)";
          return (
            <Link
              key={to}
              to={to}
              className="flex flex-1 flex-col items-center justify-center gap-1"
              aria-label={label}
            >
              <Icon
                className="h-5 w-5 transition-colors"
                strokeWidth={1.25}
                color={active ? activeColor : inactiveColor}
              />
              <span
                className="font-mono text-[10px] uppercase tracking-[0.16em] transition-colors"
                style={{ color: active ? activeColor : inactiveColor }}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
