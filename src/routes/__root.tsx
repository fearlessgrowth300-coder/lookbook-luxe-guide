import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useEffect } from "react";
import { AuthProvider } from "@/lib/auth";
import { installServerFnAuth } from "@/lib/server-fn-auth";
import { DesktopBlocker } from "@/components/DesktopBlocker";
import { InstallPrompt } from "@/components/InstallPrompt";
import { registerPwa } from "@/lib/pwa";
import appCss from "../styles.css?url";

// Install the fetch interceptor that attaches the Supabase access token to
// every server-function request. Idempotent; runs once on the client.
installServerFnAuth();

interface RouterContext {
  queryClient: QueryClient;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bone px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          404 · NOT FOUND
        </p>
        <h1 className="mt-6 font-display text-[44px] font-light leading-[1.1] text-graphite">
          This page is out of season.
        </h1>
        <Link
          to="/today"
          className="mt-8 inline-block border-b border-graphite pb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-graphite transition-opacity hover:opacity-60"
        >
          Return home
        </Link>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      { name: "theme-color", content: "#F5F1EA" },
      { title: "Atelier — Your wardrobe, styled daily" },
      {
        name: "description",
        content:
          "A quiet, considered styling companion. Photograph your wardrobe, receive one editorial outfit a day.",
      },
      { name: "author", content: "Atelier" },
      { property: "og:title", content: "Atelier — Your wardrobe, styled daily" },
      {
        property: "og:description",
        content: "A quiet, considered styling companion.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Atelier — Your wardrobe, styled daily" },
      { name: "description", content: "Atelier Style Studio is a luxury wardrobe styling app that generates daily outfit recommendations." },
      { property: "og:description", content: "Atelier Style Studio is a luxury wardrobe styling app that generates daily outfit recommendations." },
      { name: "twitter:description", content: "Atelier Style Studio is a luxury wardrobe styling app that generates daily outfit recommendations." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c9d85af7-1203-4ac1-b603-36ee00698fd9/id-preview-2c2c372c--23571140-b0a7-41a7-9dd5-c0ae7cd07ff4.lovable.app-1776984941296.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/c9d85af7-1203-4ac1-b603-36ee00698fd9/id-preview-2c2c372c--23571140-b0a7-41a7-9dd5-c0ae7cd07ff4.lovable.app-1776984941296.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "icon", type: "image/png", sizes: "192x192", href: "/pwa-192.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Production-only PWA: registers the service worker on the published
  // URL only. No-op inside Lovable preview iframes / preview hosts.
  useEffect(() => {
    void registerPwa();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DesktopBlocker>
          <Outlet />
          <InstallPrompt />
        </DesktopBlocker>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: {
              background: "var(--graphite)",
              color: "var(--bone)",
              border: "none",
              borderRadius: "2px",
              fontFamily: "var(--font-display)",
              fontSize: "15px",
              fontWeight: 400,
            },
          }}
        />
      </AuthProvider>
    </QueryClientProvider>
  );
}
