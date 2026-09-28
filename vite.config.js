import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Build the React SPA in web/ into ../static, which Express serves as-is.
//
// base: "./"  — emit RELATIVE asset URLs (./assets/xxx). The Guard router mounts
//   the app under a runtime prefix (/s/<app_id>/); relative URLs resolve under
//   whatever prefix the page is served at. NEVER set an absolute base or a fixed
//   prefix here — that produces /assets/xxx which 404s under the prefix.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./static", import.meta.url)),
    emptyOutDir: true,
  },
});
