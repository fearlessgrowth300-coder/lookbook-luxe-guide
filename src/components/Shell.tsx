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

  return (
    <div className="min-h-screen bg-bone text-graphite">
      {/* Top bar */}
      <header className="sticky top-0 z-40 h-16 border-b border-linen bg-bone/95 backdrop-blur">
        <div className="mx-auto flex h-full max-w-[1280px] items-center justify-between px-6 md:px-12 lg:px-24">
          <Link
            to="/today"
            className="font-display text-[20px] font-normal tracking-tight text-graphite"
            aria-label="Atelier home"
          >
            Atelier
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-12 md:flex" aria-label="Primary">
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
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink text-[11px] font-medium text-ink transition-colors hover:border-graphite hover:text-graphite"
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
        className="pb-24 md:pb-0"
      >
        {children}
      </motion.main>

      {/* Mobile tab bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 flex h-16 items-stretch border-t border-linen bg-bone/95 backdrop-blur md:hidden"
        aria-label="Primary mobile"
      >
        {NAV.map(({ to, label, icon: Icon }) => {
          const active = pathname.startsWith(to);
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
                color={active ? "var(--graphite)" : "var(--ink)"}
              />
              <span
                className="font-mono text-[10px] uppercase tracking-[0.16em] transition-colors"
                style={{ color: active ? "var(--graphite)" : "var(--ink)" }}
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
