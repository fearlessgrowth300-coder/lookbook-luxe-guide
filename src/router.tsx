import { createRouter, useRouter, Link } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";

function DefaultErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-bone px-6">
      <div className="max-w-md text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-signal">
          Error
        </p>
        <h1 className="mt-6 font-display text-[36px] font-light leading-[1.1] text-graphite">
          A thread came loose.
        </h1>
        {import.meta.env.DEV && (
          <pre className="mt-4 max-h-40 overflow-auto border border-linen bg-linen/40 p-3 text-left font-mono text-[11px] text-signal">
            {error.message}
          </pre>
        )}
        <div className="mt-8 flex items-center justify-center gap-6">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="border-b border-graphite pb-1 font-mono text-[11px] uppercase tracking-[0.2em] text-graphite transition-opacity hover:opacity-60"
          >
            Try again
          </button>
          <Link
            to="/today"
            className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink transition-colors hover:text-graphite"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
