// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  vite: {
    plugins: [
      VitePWA({
        registerType: "autoUpdate",
        // Critical: do NOT activate the service worker in dev. Lovable previews
        // run inside an iframe; an active SW there causes stale builds and
        // navigation interference. Production builds (published URL) get the
        // full PWA. We additionally guard runtime registration on the client.
        devOptions: { enabled: false },
        injectRegister: null, // we register manually so we can iframe-guard
        includeAssets: [
          "favicon.ico",
          "apple-touch-icon.png",
          "pwa-192.png",
          "pwa-512.png",
          "pwa-maskable.png",
        ],
        manifest: {
          name: "Atelier",
          short_name: "Atelier",
          description: "Your wardrobe, styled daily.",
          theme_color: "#F5F1EA",
          background_color: "#F5F1EA",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          icons: [
            { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/pwa-maskable.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Don't intercept SSR / TanStack internal routes.
          navigateFallbackDenylist: [/^\/~oauth/, /^\/api\//, /^\/_/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "wardrobe-images",
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
              },
            },
          ],
        },
      }),
    ],
  },
});
