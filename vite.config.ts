/// <reference types="vitest/config" />
import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pwa } from "./vite-pwa.ts";

/** Where `npm run dev` forwards API and MCP requests: a running `toodo-server`. */
const server = process.env.TOODO_SERVER ?? "http://127.0.0.1:47616";

export default defineConfig({
  plugins: [react(), tailwindcss(), pwa()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "./src") }],
  },
  build: {
    // `toodo-server`, the release package, CI, and the E2E tests serve this directory.
    outDir: "dist-web",
  },
  server: {
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // `ws` passes the pane view's WebSocket through; the Host header stays the dev server's,
    // which is what the server compares the Origin with.
    proxy: { "/api": { target: server, ws: true }, "/mcp": server },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
