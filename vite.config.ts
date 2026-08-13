import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Tauri serves the frontend from a fixed port in dev and from disk in release.
// `TAURI_ENV_*` vars are injected by the Tauri CLI when it drives the build.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Three entry points: the operator window, the projector the congregation
  // watches, and the stage display the preacher does.
  build: {
    // WebView2 on Windows is evergreen. On macOS the floor is Safari 15, which
    // is the oldest WebKit Vite's bundler can still emit for and matches the
    // Big Sur minimum declared in tauri.conf.json.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        projector: resolve(projectRoot, "projector.html"),
        stage: resolve(projectRoot, "stage.html"),
      },
    },
  },

  // Vite options tailored for Tauri: fixed port, fail instead of silently
  // hopping ports, and ignore src-tauri so Rust rebuilds don't trigger HMR.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/src-sidecar/**"],
    },
  },
});
