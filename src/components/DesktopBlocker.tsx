import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

const DESKTOP_BREAKPOINT = 600;

/**
 * Atelier is a mobile-only PWA. Above 600px viewport, we render this
 * full-viewport screen with a QR code instead of the app — there is no
 * desktop layout to fall back on.
 */
export function DesktopBlocker({ children }: { children: React.ReactNode }) {
  // Start as `null` so SSR + first client paint match (we don't know the
  // viewport at SSR time). We render the children by default and only swap
  // in the blocker after measuring on the client.
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  const [url, setUrl] = useState<string>("");

  useEffect(() => {
    const update = () => {
      setIsDesktop(window.innerWidth > DESKTOP_BREAKPOINT);
      setUrl(window.location.href);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  if (isDesktop !== true) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-bone px-8">
      <div className="flex max-w-[420px] flex-col items-center text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-ink">
          Atelier
        </p>
        <h1 className="mt-6 font-display text-[32px] font-light leading-[1.1] text-graphite">
          Atelier is mobile-only.
        </h1>
        <p className="mt-4 text-[15px] leading-[1.5] text-ink">
          Open this on your phone for the intended experience.
        </p>
        {url && (
          <div className="mt-10 border border-linen bg-bone p-5">
            <QRCodeSVG
              value={url}
              size={176}
              bgColor="#F5F1EA"
              fgColor="#2C2A28"
              level="M"
              marginSize={0}
            />
          </div>
        )}
        <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Or scan to open on your phone.
        </p>
      </div>
    </div>
  );
}
