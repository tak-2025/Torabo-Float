import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the built bundle works from a GitHub Pages project
  // sub-path (/Torabo-Float/) *and* from a plain file:// / local server,
  // which is what OBS' browser source ends up loading in local setups.
  base: "./",
  server: {
    // Not strictPort: other Torabo dev servers in this workspace already sit on
    // 5173/5174, so falling forward is friendlier than failing to boot.
    port: 5178,
  },
  build: {
    // Web Bluetooth is Chromium-only anyway, so target a modern baseline.
    target: "chrome105",
  },
});
