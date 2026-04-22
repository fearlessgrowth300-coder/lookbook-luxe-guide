import {
  Outlet,
  Link,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { installServerFnAuth } from "@/lib/server-fn-auth";
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
      { name: "viewport", content: "width=device-width, initial-scale=1" },
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
    ],
    links: [{ rel: "stylesheet", href: appCss }],
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
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
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
