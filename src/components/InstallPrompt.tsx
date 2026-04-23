import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { isIOSSafari, isStandaloneDisplay } from "@/lib/pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "atelier:install-dismissed";
const READY_KEY = "atelier:install-ready"; // set after the user generates their first look

/**
 * Mark the user as ready to be prompted (call this after their first
 * successful look generation).
 */
export function markInstallPromptReady() {
  try {
    localStorage.setItem(READY_KEY, "1");
    window.dispatchEvent(new Event("atelier:install-ready"));
  } catch {
    // ignore
  }
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [ready, setReady] = useState(false);
  const [variant, setVariant] = useState<"native" | "ios" | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandaloneDisplay()) return; // already installed
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
      setReady(localStorage.getItem(READY_KEY) === "1");
    } catch {
      // ignore
    }

    const onReady = () => setReady(true);
    window.addEventListener("atelier:install-ready", onReady);

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVariant("native");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS Safari has no beforeinstallprompt — show the manual instructions
    // variant instead.
    if (isIOSSafari()) setVariant("ios");

    return () => {
      window.removeEventListener("atelier:install-ready", onReady);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, []);

  if (!ready || !variant) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore
    }
    setVariant(null);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted" || choice.outcome === "dismissed") {
        dismiss();
      }
    } catch {
      // ignore
    }
  };

  return (
    <div
      className="fixed inset-x-0 bottom-16 z-50 flex h-14 items-center gap-3 border-t border-linen bg-linen px-3"
      role="dialog"
      aria-label="Install Atelier"
    >
      <div
        className="flex h-6 w-6 shrink-0 items-center justify-center bg-bone font-display text-[14px] font-normal text-graphite"
        aria-hidden
      >
        A
      </div>
      <p className="flex-1 truncate font-sans text-[13px] text-graphite">
        {variant === "ios"
          ? "Tap Share, then Add to Home Screen."
          : "Install Atelier for the full experience."}
      </p>
      {variant === "native" && (
        <button
          onClick={install}
          className="border-b border-graphite pb-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-graphite transition-opacity hover:opacity-60"
        >
          Install
        </button>
      )}
      <button
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="flex h-6 w-6 items-center justify-center text-ink transition-colors hover:text-graphite"
      >
        <X className="h-4 w-4" strokeWidth={1.25} />
      </button>
    </div>
  );
}
