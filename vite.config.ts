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
          // The default precache glob is ["**/*.{js,wasm,css,html}"], which would
          // sweep in the heavy ML assets: the ONNX runtime wasm (~23 MB, powers
          // @imgly/background-removal) and the HEIC decoder. Workbox's default
          // precache cap is 2 MiB and this plugin THROWS past it, so precaching
          // them broke the build (generateSW). We never want to precache 20+ MB
          // anyway — that would force every user to download it just to install
          // the PWA. Exclude them here and cache them at runtime on first use.
          globIgnores: [
            "**/*.wasm", // ort-wasm-simd-threaded.jsep-*.wasm (~23 MB)
            "**/ort*", // onnxruntime-web bundles
            "**/ort.*", // ort.bundle.min / ort.webgpu.bundle.min
            "**/heic2any*", // HEIC → JPEG decoder
            "**/heic-to*",
          ],
          // Safety net so an ordinary large JS chunk near the limit can't break
          // the build again. Heavy ML assets are handled by runtimeCaching below.
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
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
            {
              // The ML/HEIC assets we excluded from precache — cache them the
              // first time the user actually triggers background removal / a
              // HEIC upload, so the feature still works offline afterwards.
              urlPattern: /\/assets\/(ort.*\.(?:js|mjs|wasm)|.*\.wasm|heic.*\.js)$/i,
              handler: "CacheFirst",
              options: {
                cacheName: "ml-assets",
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: { statuses: [0, 200] },
                rangeRequests: true,
              },
            },
          ],
        },
      }),
    ],
  },
});
