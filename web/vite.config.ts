import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // ../shared is OUTSIDE this project, so its `import "react"` resolves by
    // walking up from ../shared — which on a checkout that also has the
    // desktop app's dependencies installed finds ../node_modules/react, not
    // web/node_modules/react. Rollup then bundles BOTH copies and the page
    // dies on the first hook ("Cannot read properties of null (reading
    // 'useState')" — react-dom primes one copy's dispatcher, shared/'s
    // components read the other's). Dev never showed it (the dep optimiser
    // already collapses them) and neither does CI (it installs web/ only, so
    // there is no second copy to find), which is exactly why this needs
    // pinning down rather than leaving to resolution order.
    dedupe: ["react", "react-dom"],
    alias: {
      // Code kept byte-identical with the desktop build (../src) — see
      // ../shared and ../docs/DESIGN-web.md.
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
      // This target's own src root, so shared code can reach a per-target
      // seam file (shared/hooks/useDiag.ts imports "~/link") by a name both
      // targets provide, instead of a relative path that would resolve
      // outside shared/.
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Relative asset URLs so the built bundle works from a GitHub Pages project
  // sub-path (/Torabo-Float/) *and* from a plain file:// / local server,
  // which is what OBS' browser source ends up loading in local setups.
  base: "./",
  server: {
    // Not strictPort: other Torabo dev servers in this workspace already sit on
    // 5173/5174, so falling forward is friendlier than failing to boot.
    port: 5178,
    // ../shared lives outside this project's root (web/); Vite's dev server
    // otherwise refuses to serve files above the detected workspace root.
    fs: {
      allow: [fileURLToPath(new URL("..", import.meta.url))],
    },
  },
  build: {
    // Web Bluetooth is Chromium-only anyway, so target a modern baseline.
    target: "chrome105",
  },
});
