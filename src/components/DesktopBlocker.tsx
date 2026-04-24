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

  // Desktop access temporarily enabled for review — render children at all sizes.
  void isDesktop;
  void url;
  return <>{children}</>;
}
