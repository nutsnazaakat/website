import type {
  CatalogFacets,
  Combo,
  ComboComponent,
  Paginated,
  Product,
  ProductFilters,
  RatingBucket,
  Review,
  ReviewSummary,
} from "@/contract";
import { productSoldOut, variantSoldOut } from "@/contract";
import { categories } from "@/mocks/categories";
import { comboSeeds } from "@/mocks/combos";
import { products } from "@/mocks/products";
import { reviews } from "@/mocks/reviews";

/**
 * The catalogue and review endpoints, for the route tests.
 *
 * `features/catalog/api` and `features/reviews/api` stopped being mocks in this plan: both now go
 * through `lib/http`, which calls `fetch`. There is no server in jsdom, so without this every route
 * test that renders a product would fail on a refused request — and the auth stub would reject it by
 * design, since an unstubbed seam is meant to say so rather than hang.
 *
 * It is the **same logic the mock seam used**, moved rather than reimplemented: `applyFilters`,
 * `buildCombo` and `summarise` are the functions that used to live in
 * `features/catalog/api/index.ts` and `features/reviews/api/index.ts`. That matters because the
 * smoke tests assert exact figures derived from `src/mocks/products.ts` — ₹132/100g, the ₹989/kg
 * 10–24kg tier, the ₹497 combo saving. A stub that recomputed them its own way would either drift
 * from those numbers or, worse, agree today and diverge silently later.
 *
 * Two behaviours are the server's rather than the mock's, deliberately, because they are what the
 * client now has to cope with:
 *
 * - lists answer the `{ items, total, page, limit }` envelope, paginated at the server's own
 *   defaults (24, capped at 60), so a consumer that reads a page length as a catalogue count is
 *   caught here rather than in a browser;
 * - facets are served whole-catalogue by their own endpoint, which is the reason `ShopPage` no
 *   longer fetches the catalogue twice.
 *
 * This file is the one place in `src/test/` allowed to read `src/mocks/` — see the override in
 * `.oxlintrc.json`. It is the test's stand-in for the server, so it is on the far side of the api
 * seam the rule protects, not a component reaching around it.
 */

/** Mirrors `CatalogService`'s `DEFAULT_LIMIT` and `MAX_LIMIT`. */
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** The pack a combo box is priced by — 4 × 250g inside means the box is a 1kg assortment. */
const COMBO_BOX_SIZE = "1kg";

const kgPrice = (p: Product) =>
  p.variants.find((v) => v.grams === 1000)?.price ?? p.variants[0]?.price ?? 0;

/** Reviews submitted during a test. Pending, so nothing in the shop may show them. */
let pending: Review[] = [];
let sequence = reviews.length;

/**
 * Packs the product endpoint should report as drained, for the test currently running.
 *
 * Every pack in `src/mocks/products.ts` is stocked — deliberately, because the pricing figures the
 * smoke suite pins are derived from that seed — so a test about sold-out rendering has to arrange
 * the stock it needs. This rewrites the *served* product on its way out, which is what a real
 * inventory change would look like to the client, and leaves the seed untouched so nothing leaks
 * into the tests that follow.
 *
 * `"*"` drains every variant. That distinction matters and is not cosmetic: `productSoldOut` is
 * computed over *all* active variants, so draining the four retail packs while the four bulk packs
 * stay stocked leaves `product.soldOut` **false** — there is something to buy, just not a retail
 * pack of it. Raising the product-level SOLD OUT badge needs `"*"`.
 *
 * Applied at `GET /catalog/products/:slug` only, which is the detail page's seam. The list, facet
 * and combo endpoints keep serving the untouched seed, so do not read this as a way to arrange a
 * sold-out card in the shop grid.
 */
let drained: { slug: string; sizes: readonly string[] | "*" } | undefined;

export function drainPacks(slug: string, sizes: readonly string[] | "*"): void {
  drained = { slug, sizes };
}

/**
 * Makes `GET /catalog/products` fail, for the test currently running.
 *
 * `GET /catalog/products?limit=60` is the whole-catalogue lookup the cart page, the cart drawer, the
 * checkout summary and the bulk cart all name a basket from, and a failed one is indistinguishable
 * from a successful one by looking at `items` alone: both leave the caller holding an empty array.
 * That difference is load-bearing now that a slug the array does not contain renders as "no longer
 * available" — without an arrangement like this, "do not make that claim when the catalogue never
 * answered" is a rule nothing can pin, and a single failed GET would tell every customer their whole
 * basket had been withdrawn.
 *
 * Deliberately narrow: it fails the *list* only. `GET /catalog/products/:slug` keeps answering, so
 * this does not double as a way to arrange a broken product page.
 */
let listFailure: string | undefined;

export function failCatalogList(message: string): void {
  listFailure = message;
}

/** Call between tests, or a submitted review outlives the case that created it. */
export function resetCatalogStub(): void {
  pending = [];
  sequence = reviews.length;
  drained = undefined;
  listFailure = undefined;
}

/**
 * `soldOut` is recomputed with the shared helpers rather than hand-set, for the reason
 * `availability.ts` gives: a second inline derivation of the rule is how a stub comes to disagree
 * with the server it stands in for.
 */
function withArrangedStock(product: Product): Product {
  if (!drained || drained.slug !== product.slug) return product;
  const { sizes } = drained;
  const variants = product.variants.map((v) =>
    sizes === "*" || sizes.includes(v.size)
      ? { ...v, available: 0, soldOut: variantSoldOut(0) }
      : v,
  );
  return {
    ...product,
    variants,
    soldOut: productSoldOut(variants.map((v) => ({ available: v.available, isActive: true }))),
  };
}

function applyFilters(list: Product[], f: ProductFilters): Product[] {
  let out = list;

  if (f.category && f.category !== "all") out = out.filter((p) => p.category === f.category);
  if (f.origin) out = out.filter((p) => p.origin === f.origin);
  if (f.grade) out = out.filter((p) => p.grade === f.grade);
  if (f.bestsellerOnly) out = out.filter((p) => p.badge === "BESTSELLER");
  if (f.maxMoq !== undefined) out = out.filter((p) => p.moqKg <= f.maxMoq!);
  if (f.channel) out = out.filter((p) => p.variants.some((v) => v.channel === f.channel));
  if (f.inStockOnly) {
    out = out.filter((p) =>
      p.variants.some((v) => v.available > 0 && (!f.channel || v.channel === f.channel)),
    );
  }

  if (f.q?.trim()) {
    const q = f.q.toLowerCase();
    out = out.filter((p) =>
      `${p.name} ${p.grade} ${p.category} ${p.origin}`.toLowerCase().includes(q),
    );
  }

  if (f.minPrice != null) out = out.filter((p) => kgPrice(p) >= f.minPrice!);
  if (f.maxPrice != null) out = out.filter((p) => kgPrice(p) <= f.maxPrice!);

  switch (f.sort) {
    case "price-asc":
      return [...out].sort((a, b) => kgPrice(a) - kgPrice(b));
    case "price-desc":
      return [...out].sort((a, b) => kgPrice(b) - kgPrice(a));
    case "rating":
      return [...out].sort((a, b) => b.rating - a.rating);
    case "best-selling":
      return [...out].sort((a, b) => b.reviewCount - a.reviewCount);
    default:
      return out;
  }
}

function page(list: Product[], filters: ProductFilters): Paginated<Product> {
  const requested = filters.page ?? 1;
  const pageNumber = Math.max(1, Math.trunc(requested));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(filters.limit ?? DEFAULT_LIMIT)));
  const start = (pageNumber - 1) * limit;
  return {
    items: list.slice(start, start + limit),
    total: list.length,
    page: pageNumber,
    limit,
  };
}

/**
 * Resolves a combo seed against the catalogue. Returns null when the box product or any component
 * is missing, so an incomplete combo drops off the page rather than rendering with a hole in its
 * component list or a savings figure computed from fewer parts than it names.
 */
function buildCombo(seed: (typeof comboSeeds)[number]): Combo | null {
  const box = products.find((p) => p.slug === seed.slug);
  const boxVariant = box?.variants.find((v) => v.size === COMBO_BOX_SIZE);
  if (!box || !boxVariant) return null;

  const components: ComboComponent[] = [];
  for (const c of seed.components) {
    const product = products.find((p) => p.slug === c.slug);
    const variant = product?.variants.find((v) => v.size === c.size);
    if (!product || !variant) return null;
    components.push({
      slug: product.slug,
      name: product.name,
      size: variant.size,
      grams: variant.grams,
      price: variant.price,
      mrp: variant.mrp,
    });
  }

  const partsMrp = components.reduce((sum, c) => sum + c.mrp, 0);
  const partsPrice = components.reduce((sum, c) => sum + c.price, 0);
  const savings = Math.max(0, partsMrp - boxVariant.price);

  return {
    slug: box.slug,
    name: box.name,
    subtitle: box.subtitle,
    blurb: seed.blurb,
    occasion: seed.occasion,
    image: box.images[0] ?? "",
    price: boxVariant.price,
    partsMrp,
    partsPrice,
    savings,
    savingsPercent: partsMrp === 0 ? 0 : Math.round((savings / partsMrp) * 100),
    totalGrams: components.reduce((sum, c) => sum + c.grams, 0),
    components,
  };
}

/** What `CatalogFacetsService` computes in SQL, over the whole catalogue rather than one page. */
function facets(): CatalogFacets {
  const prices = products.map(kgPrice);
  return {
    origins: [...new Set(products.map((p) => p.origin))].sort(),
    grades: [...new Set(products.map((p) => p.grade))].sort(),
    minPrice: prices.length === 0 ? 0 : Math.min(...prices),
    maxPrice: prices.length === 0 ? 0 : Math.max(...prices),
    categories: categories.map((c) => ({
      slug: c.slug,
      name: c.name,
      productCount: products.filter((p) => p.category === c.slug).length,
    })),
  };
}

const approvedFor = (slug: string) =>
  reviews.filter((r) => r.productSlug === slug && r.status === "approved");

/** Newest first — the order a shopper expects and the order the list renders in. */
const byNewest = (a: Review, b: Review) => b.createdAt.localeCompare(a.createdAt);

function summarise(list: Review[]): ReviewSummary {
  const total = list.length;
  const distribution: RatingBucket[] = [5, 4, 3, 2, 1].map((stars) => {
    const count = list.filter((r) => r.rating === stars).length;
    return { stars, count, percent: total === 0 ? 0 : Math.round((count / total) * 100) };
  });

  return {
    average: total === 0 ? 0 : list.reduce((sum, r) => sum + r.rating, 0) / total,
    total,
    verifiedCount: list.filter((r) => r.verifiedPurchase).length,
    distribution,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ok<T>(data: T): Response {
  return json(200, { success: true, data });
}

/** The shape `GlobalExceptionFilter` emits, so `http.ts` produces a real `ApiRequestError`. */
function notFound(message: string, path: string, method: string): Response {
  return json(404, {
    success: false,
    statusCode: 404,
    timestamp: "2026-08-20T00:00:00.000Z",
    path,
    method,
    message,
    code: "NOT_FOUND",
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

/** An arranged 503 on the listing — the shape a real outage reaches `http.ts` in. */
function unavailable(message: string, path: string, method: string): Response {
  return json(503, {
    success: false,
    statusCode: 503,
    timestamp: "2026-08-20T00:00:00.000Z",
    path,
    method,
    message,
    errorId: "stub-error-id",
    requestId: "stub-request-id",
  });
}

const bool = (raw: string | null): boolean | undefined =>
  raw === null ? undefined : raw === "true";

const num = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const text = (raw: string | null): string | undefined => raw ?? undefined;

/**
 * Reads the query string the way `qs` and the DTO do, and **rejects nothing else**: the real
 * `ValidationPipe` runs `forbidNonWhitelisted`, so an undeclared parameter is a 400 rather than an
 * ignored filter. `focus=true` reaching the server was exactly that failure.
 */
function parseFilters(query: URLSearchParams): ProductFilters | Response {
  const declared = new Set([
    "category",
    "q",
    "minPrice",
    "maxPrice",
    "origin",
    "grade",
    "bestsellerOnly",
    "inStockOnly",
    "maxMoq",
    "channel",
    "sort",
    "page",
    "limit",
  ]);
  const unknown: string[] = [];
  // `forEach` rather than `[...query.keys()]`: the iterable half of `URLSearchParams` needs the
  // `DOM.Iterable` lib, which `tsconfig.app.json` does not include.
  query.forEach((_value, key) => {
    if (!declared.has(key)) unknown.push(key);
  });
  if (unknown.length > 0) {
    return json(400, {
      success: false,
      statusCode: 400,
      timestamp: "2026-08-20T00:00:00.000Z",
      path: "/api/v1/catalog/products",
      method: "GET",
      message: "Validation failed",
      code: "VALIDATION_FAILED",
      details: Object.fromEntries(
        unknown.map((key) => [key, [`property ${key} should not exist`]]),
      ),
      errorId: "stub-error-id",
      requestId: "stub-request-id",
    });
  }

  const sort = text(query.get("sort")) as ProductFilters["sort"];
  const channel = text(query.get("channel")) as ProductFilters["channel"];
  return {
    ...(text(query.get("category")) === undefined ? {} : { category: query.get("category")! }),
    ...(text(query.get("q")) === undefined ? {} : { q: query.get("q")! }),
    ...(text(query.get("origin")) === undefined ? {} : { origin: query.get("origin")! }),
    ...(text(query.get("grade")) === undefined ? {} : { grade: query.get("grade")! }),
    minPrice: num(query.get("minPrice")),
    maxPrice: num(query.get("maxPrice")),
    maxMoq: num(query.get("maxMoq")),
    bestsellerOnly: bool(query.get("bestsellerOnly")),
    inStockOnly: bool(query.get("inStockOnly")),
    page: num(query.get("page")),
    limit: num(query.get("limit")),
    ...(sort === undefined ? {} : { sort }),
    ...(channel === undefined ? {} : { channel }),
  };
}

const PRODUCT = /^\/catalog\/products\/([^/]+)$/;
const RELATED = /^\/catalog\/products\/([^/]+)\/related$/;
const REVIEWS = /^\/catalog\/products\/([^/]+)\/reviews$/;
const REVIEW_SUMMARY = /^\/catalog\/products\/([^/]+)\/reviews\/summary$/;
const CATEGORY = /^\/catalog\/categories\/([^/]+)$/;

/**
 * Answers a catalogue or review request, or returns `undefined` when the URL is not one of them so
 * the caller can fall through to its own handling.
 */
export function handleCatalogRequest(
  url: string,
  method: string,
  init?: RequestInit,
): Response | undefined {
  const rest = url.startsWith("/api/v1") ? url.slice("/api/v1".length) : url;
  const [path, rawQuery] = rest.split("?");
  if (path === undefined || !path.startsWith("/catalog")) return undefined;

  const query = new URLSearchParams(rawQuery ?? "");
  const slugOf = (match: RegExpExecArray) => decodeURIComponent(match[1] ?? "");

  if (method === "GET" && path === "/catalog/products") {
    if (listFailure) return unavailable(listFailure, url, method);
    const filters = parseFilters(query);
    if (filters instanceof Response) return filters;
    return ok(page(applyFilters(products, filters), filters));
  }

  if (method === "GET" && path === "/catalog/products/facets") return ok(facets());

  if (method === "GET" && path === "/catalog/products/bestsellers") {
    const limit = num(query.get("limit")) ?? 8;
    const matching = products.filter((p) => p.badge === "BESTSELLER");
    return ok(page(matching, { limit }));
  }

  const related = RELATED.exec(path);
  if (method === "GET" && related) {
    const limit = num(query.get("limit")) ?? 4;
    const slug = slugOf(related);
    const base = products.find((p) => p.slug === slug);
    if (!base) return ok({ items: [], total: 0, page: 1, limit });
    const siblings = products.filter((p) => p.category === base.category && p.slug !== slug);
    return ok(page(siblings, { limit }));
  }

  const summary = REVIEW_SUMMARY.exec(path);
  if (method === "GET" && summary) return ok(summarise(approvedFor(slugOf(summary))));

  const reviewList = REVIEWS.exec(path);
  if (reviewList) {
    const slug = slugOf(reviewList);
    if (method === "GET") return ok([...approvedFor(slug)].sort(byNewest));
    if (method === "POST") {
      const draft = JSON.parse(String(init?.body ?? "{}")) as {
        author: string;
        rating: number;
        body: string;
        imageUrl?: string;
      };
      sequence += 1;
      // Always PENDING, and `verifiedPurchase` always false: only a server that can match the
      // reviewer against a delivered order may set that badge.
      const created: Review = {
        id: `rev-${String(sequence).padStart(4, "0")}`,
        productSlug: slug,
        author: draft.author,
        rating: draft.rating,
        body: draft.body,
        ...(draft.imageUrl ? { imageUrl: draft.imageUrl } : {}),
        verifiedPurchase: false,
        status: "pending",
        createdAt: "2026-08-20T00:00:00.000Z",
      };
      pending.push(created);
      return json(201, { success: true, data: created });
    }
  }

  const product = PRODUCT.exec(path);
  if (method === "GET" && product) {
    const slug = slugOf(product);
    const found = products.find((p) => p.slug === slug);
    return found
      ? ok(withArrangedStock(found))
      : notFound("That product may have been renamed or is no longer stocked.", url, method);
  }

  if (method === "GET" && path === "/catalog/categories") return ok(categories);

  const category = CATEGORY.exec(path);
  if (method === "GET" && category) {
    const found = categories.find((c) => c.slug === slugOf(category));
    return found ? ok(found) : notFound("That category does not exist.", url, method);
  }

  if (method === "GET" && path === "/catalog/combos") {
    return ok(comboSeeds.map(buildCombo).filter((c): c is Combo => c !== null));
  }

  return undefined;
}
