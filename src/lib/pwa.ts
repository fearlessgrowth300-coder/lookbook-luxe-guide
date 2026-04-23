/**
 * Production-only PWA registration with iframe / preview-host guard.
 *
 * Why guarded: Lovable's editor preview runs inside an iframe on
 * *.lovable.app / *.lovableproject.com hosts. A registered service worker
 * there will cache stale builds and intercept navigation, breaking the
 * preview. So we only register on the *published* deployment.
 */

const PREVIEW_HOST_PATTERNS = [
  /lovableproject\.com$/i,
  /^id-preview--/i,
  /\.lovable\.app$/i, // includes id-preview--*.lovable.app and project--*.lovable.app preview
];

function isInsideIframe(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    // Cross-origin access throws → assume iframe.
    return true;
  }
}

function isPreviewHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  // The published *.lovable.app URL (e.g. atelier.lovable.app or a custom
  // domain) is the only place we want the SW. Anything that looks like a
  // preview host or the project--<id> dev subdomain → no SW.
  if (/^project--/i.test(host)) return true;
  if (/^id-preview--/i.test(host)) return true;
  if (/lovableproject\.com$/i.test(host)) return true;
  return false;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  // iOS uses navigator.standalone; everything else uses the matchMedia query.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return (
    iosStandalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true
  );
}

export function isIOSSafari(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  return isIOS && isSafari;
}

export async function registerPwa(): Promise<void> {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  // In production-only mode: bail out everywhere except the live deploy.
  if (import.meta.env.DEV) return;
  if (isInsideIframe()) return;
  if (isPreviewHost()) {
    // Be defensive: if a previous build registered a SW on this host, kill it.
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      // ignore
    }
    return;
  }

  try {
    // virtual:pwa-register is provided at build time by vite-plugin-pwa.
    // Dynamically imported so dev/preview never loads the registrar.
    const { registerSW } = await import(
      /* @vite-ignore */ "virtual:pwa-register"
    );
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        // Periodic update check every hour while the tab is alive.
        if (registration) {
          setInterval(
            () => {
              registration.update().catch(() => {});
            },
            60 * 60 * 1000,
          );
        }
      },
    });
  } catch (err) {
    // Silent: PWA is a progressive enhancement.
    console.warn("[pwa] registration skipped:", err);
  }
}
