import { describe, expect, it } from "vitest";

/**
 * The route files and the generated route tree, read as text through Vite rather than `node:fs`.
 *
 * Reading them with `readdirSync`/`readFileSync` and `import.meta.dirname` is the obvious first
 * attempt and it *runs* correctly under Vitest — but it does not typecheck. `tsconfig.app.json` pins
 * `"types": ["vite/client"]`, so `node:fs`, `node:path` and `import.meta.dirname` are all unknown to
 * `tsc -b`, and the alternative — adding `"node"` to the app's types — would make `process` and
 * `Buffer` typecheck in every file of a browser bundle to buy one test a directory listing.
 *
 * `import.meta.glob` is typed by `vite/client`, which is already there. `?raw` bypasses the
 * transform pipeline and hands back the file's own source, and `eager` inlines it, so these are the
 * same bytes `readFileSync` would have returned.
 */
const routeFiles: Record<string, string> = import.meta.glob("../routes/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
});

const generatedTree: Record<string, string> = import.meta.glob("../routeTree.gen.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const relativeToRoutes = (key: string) => key.replace("../routes/", "");

/**
 * The admin console is a separate application in its own repository. This suite is what stops an
 * admin screen drifting back into the customer app — which is the easy thing to do, because the
 * component library and the auth client are right here and it would work.
 *
 * It would also mean shipping admin code to every shopper and putting admin screens on the customer
 * origin, which is precisely the isolation the separate repo was chosen for.
 */
describe("the customer app contains no admin surface", () => {
  /**
   * Every assertion below is an *absence*, so a glob that quietly matched nothing would make all
   * three pass while measuring nothing at all. This is the control on the control.
   */
  it("is actually reading the route files", () => {
    expect(Object.keys(routeFiles).length).toBeGreaterThan(30);
    expect(Object.keys(generatedTree)).toHaveLength(1);
    expect(routeFiles["../routes/__root.tsx"]).toContain("createRootRoute");
  });

  it("has no route file under an admin path", () => {
    const offenders = Object.keys(routeFiles)
      .map(relativeToRoutes)
      .filter((file) => /(^|[./\\])admin/i.test(file));
    expect(offenders).toEqual([]);
  });

  it("declares no route whose path is /admin", () => {
    const offenders = Object.entries(routeFiles)
      .filter(([file]) => file.endsWith(".tsx") || file.endsWith(".ts"))
      .filter(([, source]) => /createFileRoute\(\s*["'`]\/admin/.test(source))
      .map(([file]) => relativeToRoutes(file));
    expect(offenders).toEqual([]);
  });

  /**
   * The generated route tree is the honest answer to "what does this app actually serve", because it
   * is what the router registers. A hand-written route file that escaped the checks above would still
   * appear here.
   */
  it("registers no /admin path in the generated route tree", () => {
    for (const tree of Object.values(generatedTree)) {
      expect(tree).not.toMatch(/["'`]\/admin/);
    }
  });
});
