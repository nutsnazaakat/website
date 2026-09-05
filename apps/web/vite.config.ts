/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sharedSrc = path.resolve(repoRoot, "packages/shared/src");
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
// Node 25+ installs a stub localStorage that has no .clear(); jsdom then skips its polyfill.
const execArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    // `@/contract` must precede `@`, or `@` swallows it into `src/contract`.
    // Point at TypeScript *source*, not `packages/shared/dist`. A linked CommonJS
    // workspace package previously rendered every route blank in Vite dev — Rollup
    // (build/preview) and Vitest were fine. Source-via-alias avoids that class of bug.
    alias: [
      { find: "@/contract", replacement: sharedSrc },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    /**
     * Proxying the API keeps the frontend and the backend on one origin in development, so
     * `SameSite` behaves as it will in production and there is no CORS preflight to debug.
     *
     * `changeOrigin: false` is explicit rather than relying on the default: it keeps the `Host`
     * header as `localhost:5173`, which is what makes the backend's `Domain=localhost` session
     * cookies acceptable to the browser.
     */
    proxy: {
      "/api": {
        target: "http://localhost:4400",
        changeOrigin: false,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    execArgv,
  },
});
