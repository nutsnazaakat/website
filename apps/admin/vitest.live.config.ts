/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const execArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

/**
 * The live-backend run, in its own config because it is the inverse of the default one.
 *
 * `vite.config.ts` **excludes** `*.integration.tsx` so `npm test` never needs a service on :4400;
 * this includes only those files. It is written standalone rather than merged from the base
 * config: `mergeConfig` concatenates arrays, so the base's `exclude` would survive and cancel this
 * one's `include` exactly.
 *
 * Neither Tailwind nor the router generator is loaded — nothing here renders to a screen anybody
 * looks at, and the route tree is already on disk.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@/contract",
        replacement: path.resolve(import.meta.dirname, "../../packages/shared/src"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.integration.tsx"],
    execArgv,
    // A real network round trip per assertion, against a real database.
    testTimeout: 30_000,
    // One at a time: the cases share a database and one of them transitions a real order.
    fileParallelism: false,
  },
});
