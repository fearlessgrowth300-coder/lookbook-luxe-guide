// Client-side fetch interceptor: attaches the current Supabase access token
// as a Bearer Authorization header to every TanStack server-function call
// (`/_serverFn/...`). This is what `requireSupabaseAuth` middleware reads.
//
// Without this, server functions throw a raw 401 Response which surfaces in
// the browser as "Error: [object Response]" with a blank screen.
import { supabase } from "@/integrations/supabase/client";

let installed = false;

export function installServerFnAuth() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes("/_serverFn/")) {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) {
        const headers = new Headers(init?.headers ?? {});
        if (!headers.has("authorization") && !headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        return originalFetch(input, { ...init, headers });
      }
    }
    return originalFetch(input, init);
  };
}
