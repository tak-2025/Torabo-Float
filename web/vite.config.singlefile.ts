import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { viteSingleFile } from "vite-plugin-singlefile";

// Separate config for the "just double-click index.html" build. Kept apart
// from vite.config.ts on purpose:
//   - Cloudflare Pages / `npm run build` / `npm run dev` must never see this
//     plugin or its settings — this config is only ever invoked explicitly
//     via `npm run build:single` (see package.json).
//   - Output goes to dist-single/, never dist/, so it can't get swept up by
//     the Cloudflare Pages deploy (which publishes dist/) or by build.yml's
//     artifact upload.
//
// vite-plugin-singlefile inlines all JS/CSS (and, via its default asset
// inlining, small binary assets) as data: URIs directly into index.html, so
// the result is one self-contained file with no relative asset requests —
// safe to open straight from the filesystem (file://) with no server.
export default defineConfig({
  // viteSingleFile()'s useRecommendedBuildConfig (default: on) already sets
  // base/"./" assetsInlineLimit/cssCodeSplit/assetsDir/rollup output for us —
  // only outDir needs setting explicitly here.
  plugins: [react(), viteSingleFile()],
  build: {
    target: "chrome105",
    outDir: "dist-single",
  },
});
