/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sharedSrc = path.resolve(repoRoot, "packages/shared/src");
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const execArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

export default defineConfig({
  plugins: [
    // Must precede the react plugin, per the plugin's own guidance: it generates the route tree
    // that `main.tsx` imports, and react's transform would otherwise run before the file exists.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: false,
      // `routes.test.tsx` lives beside the routes it mounts, on purpose — it is about them. The
      // generator would otherwise warn on every run that it exports no `Route`.
      routeFileIgnorePattern: "\\.test\\.tsx?$",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: "@/contract", replacement: sharedSrc },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  server: {
    // The admin console runs on its own port, and its own origin in production. Spec §7.1: two
    // applications on one origin share cookies, CSP and service-worker scope, so an XSS anywhere
    // in the storefront would run with whatever the admin session can reach.
    port: 5174,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": { target: "http://localhost:4400", changeOrigin: true },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    execArgv,
    // `*.integration.tsx` needs a backend on :4400 and a seeded database, so it is not part of
    // `npm test`. `npm run test:live` opts into it.
    exclude: ["node_modules/**", "dist/**", "src/**/*.integration.tsx"],
  },
});
