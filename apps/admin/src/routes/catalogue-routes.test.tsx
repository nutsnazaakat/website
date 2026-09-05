import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQueryClient } from "@/app/query-client";
import { AppProviders, createAppRouter } from "@/app/router";
import { ADMIN_USER, apiError, installApi, page, type Recorded } from "@/test/server";
import {
  ALMONDS,
  BUSINESS_ANAND,
  CATEGORIES,
  CATEGORY_GIFTING,
  INVENTORY_LOW,
  INVENTORY_OUT,
  LEDGER,
  MAKHANA_DRAFT,
  TIER_BUSINESS,
  TIER_QUOTE_ONLY,
  TIER_SEGMENT,
} from "@/test/catalogue-fixtures";

/**
 * Plan 9.6b Group A — the catalogue and stock screens, proved by mounting **the real router** and
 * asserting on content *inside* each route.
 *
 * That phrasing is the whole design, carried over from `routes.test.tsx`: a test that asserts a
 * route "resolved" passes perfectly against a **blank page**, which is exactly what a TanStack
 * layout route without an `<Outlet />` produces — no error, no warning, a successful match and
 * nothing painted. `/products` has children, so it is a directory (`index.tsx` + `$id.tsx` +
 * `new.tsx`) with no `products.tsx` beside it, and every case below reaches for a string one of
 * those child components is responsible for.
 *
 * A file of its own rather than more cases in `routes.test.tsx`, because Group B is written
 * concurrently in a separate checkout and two files merge where one appended-to file conflicts.
 */

let api: { calls: Recorded[]; restore: () => void } | null = null;

function mount(path: string, handlers: Record<string, (call: Recorded) => unknown>) {
  api = installApi(handlers);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppProviders router={router} queryClient={createQueryClient()} />);
  return { router, calls: api.calls };
}

/** Every screen behind the guard needs a session. */
const asAdmin = {
  "GET /auth/me": () => ADMIN_USER,
  "GET /admin/categories": () => CATEGORIES,
};

beforeEach(() => {
  document.cookie = "nn_csrf=test-csrf; path=/";
});

afterEach(() => {
  api?.restore();
  api = null;
  document.cookie = "nn_csrf=; path=/; max-age=0";
});

describe("/products — the list", () => {
  it("lists published products and drafts together, which is the point of the admin view", async () => {
    mount("/products", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS, MAKHANA_DRAFT], 2),
    });

    const table = await screen.findByRole("table", { name: "Products, drafts included" });
    expect(screen.getByRole("heading", { name: "Products" })).toBeInTheDocument();

    for (const column of ["Product", "Category", "Packs", "Price", "Stock", "Status", "Updated"]) {
      expect(within(table).getByRole("columnheader", { name: column })).toBeInTheDocument();
    }

    expect(
      within(table).getByRole("link", { name: "Premium California Almonds" }),
    ).toBeInTheDocument();
    // The draft is listed and marked. `GET /catalog/products` would have hidden it entirely.
    expect(within(table).getByRole("link", { name: "Roasted Makhana" })).toBeInTheDocument();
    expect(within(table).getByText("Draft")).toBeInTheDocument();
    expect(within(table).getByText("Published")).toBeInTheDocument();

    // Rupees, not paise: the 500 g pack is ₹449 and the 50 kg pack ₹34,500.
    expect(within(table).getByText("₹449 – ₹34,500")).toBeInTheDocument();
    // One of two packs is active, so the column says so rather than claiming two are on sale.
    expect(within(table).getByText("1 of 2")).toBeInTheDocument();
  });

  it("reads its filters out of the URL and sends only what the DTO declares", async () => {
    const { calls } = mount("/products?q=almond&category=nuts&published=false&bogus=1", {
      ...asAdmin,
      "GET /admin/products": () => page([MAKHANA_DRAFT]),
    });

    await screen.findByRole("table", { name: "Products, drafts included" });
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/products"));
      expect(found).toBeDefined();
      return found;
    });

    expect(request?.url).toContain("q=almond");
    expect(request?.url).toContain("category=nuts");
    expect(request?.url).toContain("published=false");
    // `forbidNonWhitelisted` answers 400 for an undeclared parameter, and `search: { strict: true }`
    // is what makes `validateSearch` actually *remove* it rather than merely fail to add it.
    expect(request?.url).not.toContain("bogus");

    expect(screen.getByLabelText("Category")).toHaveValue("nuts");
    expect(screen.getByLabelText("Status")).toHaveValue("false");
  });

  it("reaches the create screen from the list, and paints it", async () => {
    const user = userEvent.setup();
    const { router } = mount("/products", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS]),
    });

    await screen.findByRole("table", { name: "Products, drafts included" });
    await user.click(screen.getByRole("button", { name: "New product" }));

    // Content inside the child route, not merely the pathname: `/products` is a directory with an
    // `index.tsx`, so a mistake that turned it into a layout without an `<Outlet />` would resolve
    // this path and paint nothing.
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/products/new");
  });

  it("writes a changed filter back into the URL, so the view is shareable", async () => {
    const user = userEvent.setup();
    const { router } = mount("/products", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS]),
    });

    await screen.findByRole("table", { name: "Products, drafts included" });
    await user.selectOptions(screen.getByLabelText("Status"), "true");

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ published: true });
    });
  });
});

describe("/products/new", () => {
  it("renders the create form inside the route", async () => {
    mount("/products/new", asAdmin);

    // Waited on a field, not the heading: the heading paints while the categories query is pending.
    expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New product" })).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByLabelText("HSN code")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create product" })).toBeInTheDocument();

    // §5b: SKU stays variant-level. There is no product-level SKU column and no input for one.
    expect(screen.queryByLabelText("SKU")).toBeNull();
    // A product is always created unpublished, so there is no checkbox the PATCH would reject.
    expect(screen.queryByLabelText(/Published/)).toBeNull();
    expect(screen.getByText(/A new product is always created unpublished/)).toBeInTheDocument();
  });

  it("is a static sibling of $id and never reaches it", async () => {
    const { calls } = mount("/products/new", asAdmin);

    await screen.findByLabelText("Name");
    // If `$id` had won the match, this would have been `GET /admin/products/new` and a 400 from
    // `ParseUUIDPipe`.
    expect(calls.some((call) => call.url.includes("/admin/products/new"))).toBe(false);
  });
});

describe("/products/$id — the detail", () => {
  const detail = {
    ...asAdmin,
    [`GET /admin/products/${ALMONDS.id}`]: () => ALMONDS,
  };

  it("renders the form, the packs and the storefront panel inside the route", async () => {
    mount(`/products/${ALMONDS.id}`, detail);

    const packs = await screen.findByRole("table", {
      name: "Packs of Premium California Almonds",
    });
    expect(screen.getByRole("heading", { name: "Premium California Almonds" })).toBeInTheDocument();

    // The form is populated from the product, not blank.
    expect(screen.getByLabelText("Name")).toHaveValue("Premium California Almonds");
    expect(screen.getByLabelText("Slug")).toHaveValue("premium-california-almonds");
    expect(screen.getByLabelText("HSN code")).toHaveValue("0802");

    // Both packs, the withdrawn one included — deactivating is how a pack is taken off sale
    // without destroying its ledger, and a list that hid it would offer no way back.
    expect(within(packs).getByText("PCA-500G")).toBeInTheDocument();
    expect(within(packs).getByText("PCA-50KG")).toBeInTheDocument();
    expect(within(packs).getByText("Withdrawn")).toBeInTheDocument();
    // Rupees on the wire, rendered as rupees.
    expect(within(packs).getByText("₹449")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Storefront" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpublish" })).toBeInTheDocument();
  });

  it("does not offer a low-stock threshold on an existing pack, and says where it moved", async () => {
    const user = userEvent.setup();
    mount(`/products/${ALMONDS.id}`, detail);

    const packs = await screen.findByRole("table", {
      name: "Packs of Premium California Almonds",
    });
    // Named per row, so this reaches the pack it means rather than whichever rendered first.
    await user.click(within(packs).getByRole("button", { name: "Edit PCA-500G" }));

    expect(await screen.findByText("Editing PCA-500G")).toBeInTheDocument();
    // `UpdateVariantDto` excludes it: the threshold lives on the `Inventory` row and only
    // `InventoryService` may write it. An input here could not save.
    expect(screen.queryByLabelText("Low-stock threshold")).toBeNull();
    expect(
      screen.getByText(/Stock and its low-stock threshold are not editable here/),
    ).toBeInTheDocument();
  });

  it("offers the threshold once, on a new pack, because that is the only place it can be set", async () => {
    const user = userEvent.setup();
    mount(`/products/${ALMONDS.id}`, detail);

    await screen.findByRole("table", { name: "Packs of Premium California Almonds" });
    await user.click(screen.getByRole("button", { name: "Add a pack" }));

    expect(await screen.findByLabelText("Low-stock threshold")).toBeInTheDocument();
    expect(screen.getByText(/The threshold can only be set here, at creation/)).toBeInTheDocument();
  });

  it("renders a refused delete as the reason plus the unpublish it suggests", async () => {
    const user = userEvent.setup();
    mount(`/products/${ALMONDS.id}`, {
      ...detail,
      // The real refusal: 409, `ENTITY_IN_USE`, `details` naming what blocks it.
      [`DELETE /admin/products/${ALMONDS.id}`]: () =>
        apiError(
          409,
          "This product has stock movement history, which is append-only and must outlive it. Unpublish it instead, or deactivate its variants.",
          "ENTITY_IN_USE",
          { productId: ALMONDS.id, inventoryTransactions: 34 },
        ),
    });

    await screen.findByRole("table", { name: "Packs of Premium California Almonds" });
    await user.click(screen.getByRole("button", { name: "Delete this product" }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This product cannot be deleted.");
    expect(alert).toHaveTextContent("stock movement history");
    // The count, so an operator knows whether this is one stray order or a year of trade.
    expect(alert).toHaveTextContent("34 stock movements reference it.");
    // The non-destructive operation, offered in place rather than left to be found.
    expect(screen.getByRole("button", { name: "Unpublish instead" })).toBeInTheDocument();
  });

  it("unpublishes through the publish pair, not through a PATCH field", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/products/${ALMONDS.id}`, {
      ...detail,
      [`POST /admin/products/${ALMONDS.id}/unpublish`]: () => ({
        ...ALMONDS,
        isPublished: false,
      }),
    });

    await screen.findByRole("table", { name: "Packs of Premium California Almonds" });
    await user.click(screen.getByRole("button", { name: "Unpublish" }));

    expect(
      await screen.findByRole("button", { name: "Publish to the storefront" }),
    ).toBeInTheDocument();

    const write = calls.find((call) => call.url.endsWith("/unpublish"));
    expect(write?.method).toBe("POST");
  });

  it("explains a missing product rather than rendering an empty detail", async () => {
    mount("/products/8a4b1f2c-1111-4c3a-9f11-2c9d5c7e9999", {
      ...asAdmin,
      "GET /admin/products/8a4b1f2c-1111-4c3a-9f11-2c9d5c7e9999": () =>
        apiError(404, "No such product.", "NOT_FOUND"),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("This product could not be loaded.");
    expect(screen.getByText("No such product.")).toBeInTheDocument();
  });
});

describe("/categories", () => {
  it("lists published and unpublished categories, and says what unpublishing does", async () => {
    mount("/categories", asAdmin);

    const table = await screen.findByRole("table", { name: "Categories, in display order" });
    expect(screen.getByRole("heading", { name: "Categories" })).toBeInTheDocument();

    expect(within(table).getByText("Nuts")).toBeInTheDocument();
    expect(within(table).getByText("Gifting")).toBeInTheDocument();
    expect(within(table).getByText("Tile shown")).toBeInTheDocument();
    expect(within(table).getByText("Tile hidden")).toBeInTheDocument();

    // Spec §5b, decided by the user and pinned by a backend test. An operator who expects a bulk
    // withdrawal and gets a hidden menu entry has been misled, so the screen says it up front.
    expect(
      screen.getByText("Unpublishing a category hides its tile, not its products."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/still reachable from search, the shop grid and its own URL/),
    ).toBeInTheDocument();
  });

  it("offers no delete, because there is no delete route", async () => {
    mount("/categories", asAdmin);

    await screen.findByRole("table", { name: "Categories, in display order" });
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByText(/A category cannot be deleted/)).toBeInTheDocument();
  });

  it("opens the edit form from the URL, populated from the row", async () => {
    mount(`/categories?edit=${CATEGORY_GIFTING.id}`, asAdmin);

    expect(await screen.findByText("Editing Gifting")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Gifting");
    expect(screen.getByLabelText("Slug")).toHaveValue("gifting");
    // The one field a product form does not have: a category has no publish endpoint pair, so this
    // checkbox is its only route to being listed.
    expect(screen.getByLabelText("On the storefront")).toHaveValue("false");
  });

  it("saves a change through PATCH and rebuilds the row from the answer", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/categories?edit=${CATEGORY_GIFTING.id}`, {
      ...asAdmin,
      [`PATCH /admin/categories/${CATEGORY_GIFTING.id}`]: () => ({
        ...CATEGORY_GIFTING,
        name: "Gift Boxes",
        isPublished: true,
      }),
    });

    await screen.findByText("Editing Gifting");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Gift Boxes");
    await user.click(screen.getByRole("button", { name: "Save category" }));

    const table = await screen.findByRole("table", { name: "Categories, in display order" });
    expect(await within(table).findByText("Gift Boxes")).toBeInTheDocument();

    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.url).toContain(`/admin/categories/${CATEGORY_GIFTING.id}`);
    expect(write?.body).toContain('"name":"Gift Boxes"');
  });

  it("opens a blank create form on ?edit=new", async () => {
    mount("/categories?edit=new", asAdmin);

    expect(await screen.findByRole("heading", { name: "New category" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create category" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
  });
});

describe("/inventory", () => {
  const stock = {
    ...asAdmin,
    "GET /admin/inventory": () => page([INVENTORY_LOW, INVENTORY_OUT], 2),
  };

  it("defaults to the low/out filter, because that is what the screen is for", async () => {
    const { calls } = mount("/inventory", stock);

    const table = await screen.findByRole("table", { name: "Stock, most urgent first" });
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();

    // `low` is inclusive of `out` — spec §12's `available <= lowStockThreshold` — so one filter
    // answers "what needs ordering" and the control is three-way rather than two checkboxes.
    expect(screen.getByLabelText("Stock position")).toHaveValue("low");
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/inventory"));
      expect(found).toBeDefined();
      return found;
    });
    expect(request?.url).toContain("status=low");

    for (const column of [
      "SKU",
      "Product",
      "Pack",
      "Current",
      "Reserved",
      "Available",
      "Threshold",
      "Position",
    ]) {
      expect(within(table).getByRole("columnheader", { name: column })).toBeInTheDocument();
    }
    expect(within(table).getByText("Low")).toBeInTheDocument();
    expect(within(table).getByText("Out of stock")).toBeInTheDocument();
    // A withdrawn pack is still listed: stock does not stop existing because the pack stopped
    // being offered, and hiding it would strand real inventory in a screen claiming to show all.
    expect(within(table).getByText(/Pack withdrawn/)).toBeInTheDocument();
  });

  it("sends no status at all for 'every position', because the DTO has no such value", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/inventory", stock);

    await screen.findByRole("table", { name: "Stock, most urgent first" });
    await user.selectOptions(screen.getByLabelText("Stock position"), "all");

    await waitFor(() => {
      expect(calls.filter((call) => call.url.includes("/admin/inventory")).length).toBeGreaterThan(
        1,
      );
    });
    const latest = calls.filter((call) => call.url.includes("/admin/inventory")).at(-1);
    // `status=all` would be a 400 under `forbidNonWhitelisted`. "Everything" is the absence of the
    // parameter, and `all` never leaves this screen.
    expect(latest?.url).not.toContain("status=");
  });

  it("opens the ledger from the URL, and names it as the audit trail for stock", async () => {
    mount(`/inventory?variant=${INVENTORY_LOW.variantId}`, {
      ...stock,
      [`GET /admin/inventory/${INVENTORY_LOW.variantId}/transactions`]: () => page(LEDGER, 2),
    });

    const ledger = await screen.findByRole("table", {
      name: "Stock movements for PCA-500G",
    });
    expect(within(ledger).getByText("Order NN-2026-005107")).toBeInTheDocument();
    expect(within(ledger).getByText("SALE")).toBeInTheDocument();
    expect(within(ledger).getByText("RECEIPT")).toBeInTheDocument();
    expect(within(ledger).getByText("-2")).toBeInTheDocument();
    expect(within(ledger).getByText("+10")).toBeInTheDocument();
    // A `SALE` is written by checkout on a customer's behalf, so it has no admin to attribute to.
    expect(within(ledger).getByText("System")).toBeInTheDocument();
    expect(within(ledger).getByText("Nazaakat Admin")).toBeInTheDocument();

    // The two trails, named, because an operator who can reach both needs to know which answers
    // what: `GET /admin/audit-logs` deliberately carries no stock movements.
    expect(
      screen.getByText(/the admin audit log deliberately carries no stock movements/),
    ).toBeInTheDocument();
  });

  it("requires a reason on an adjustment and sends the signed delta", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/inventory?variant=${INVENTORY_LOW.variantId}`, {
      ...stock,
      [`GET /admin/inventory/${INVENTORY_LOW.variantId}/transactions`]: () => page(LEDGER, 2),
      [`PATCH /admin/inventory/${INVENTORY_LOW.variantId}`]: () => ({
        onHand: 3,
        balanceAfter: 3,
      }),
    });

    await screen.findByRole("table", { name: "Stock movements for PCA-500G" });

    // Nothing typed yet: the control is disabled rather than offering a write the DTO refuses.
    expect(screen.getByRole("button", { name: "Record adjustment" })).toBeDisabled();
    // Zero is refused by `@NotEquals(0)` and again by the service — it would write a ledger row
    // asserting a movement that never happened.
    await user.type(screen.getByLabelText("Change (packs)"), "0");
    expect(screen.getByRole("button", { name: "Record adjustment" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Change (packs)"));
    await user.type(screen.getByLabelText("Change (packs)"), "-5");
    await user.type(screen.getByLabelText("Reason"), "Damaged in transit");
    await user.click(screen.getByRole("button", { name: "Record adjustment" }));

    const write = await waitFor(() => {
      const found = calls.find(
        (call) =>
          call.method === "PATCH" &&
          call.url.endsWith(`/admin/inventory/${INVENTORY_LOW.variantId}`),
      );
      expect(found).toBeDefined();
      return found;
    });
    expect(write?.body).toBe(JSON.stringify({ delta: -5, reason: "Damaged in transit" }));
  });

  it("changes a threshold on its own route, and says it writes no ledger row", async () => {
    const user = userEvent.setup();
    const { calls } = mount(`/inventory?variant=${INVENTORY_LOW.variantId}`, {
      ...stock,
      [`GET /admin/inventory/${INVENTORY_LOW.variantId}/transactions`]: () => page(LEDGER, 2),
      [`PATCH /admin/inventory/${INVENTORY_LOW.variantId}/threshold`]: () => ({
        ...INVENTORY_LOW,
        lowStockThreshold: 25,
        low: true,
      }),
    });

    await screen.findByRole("table", { name: "Stock movements for PCA-500G" });
    expect(screen.getByLabelText("Warn at or below")).toHaveValue(10);
    // Split across a `<strong>`, so matched in two parts rather than with a regex that would pass
    // by accident on whichever half survived a rewording.
    expect(screen.getByText(/Changing it moves no stock/)).toBeInTheDocument();
    expect(screen.getByText("no ledger row")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Warn at or below"));
    await user.type(screen.getByLabelText("Warn at or below"), "25");
    await user.click(screen.getByRole("button", { name: "Save threshold" }));

    const write = await waitFor(() => {
      const found = calls.find((call) => call.url.endsWith("/threshold"));
      expect(found).toBeDefined();
      return found;
    });
    expect(write?.method).toBe("PATCH");
    expect(write?.body).toBe(JSON.stringify({ lowStockThreshold: 25 }));
  });

  it("reports a refused adjustment in the server's own words", async () => {
    const user = userEvent.setup();
    mount(`/inventory?variant=${INVENTORY_LOW.variantId}`, {
      ...stock,
      [`GET /admin/inventory/${INVENTORY_LOW.variantId}/transactions`]: () => page(LEDGER, 2),
      // The real refusal: the conditional UPDATE's `onHand + delta >= reserved` failed.
      [`PATCH /admin/inventory/${INVENTORY_LOW.variantId}`]: () =>
        apiError(
          409,
          "That adjustment would take stock below what is already reserved for open orders.",
          "OUT_OF_STOCK",
          { variantId: INVENTORY_LOW.variantId, delta: -50 },
        ),
    });

    await screen.findByRole("table", { name: "Stock movements for PCA-500G" });
    await user.type(screen.getByLabelText("Change (packs)"), "-50");
    await user.type(screen.getByLabelText("Reason"), "Stocktake correction");
    await user.click(screen.getByRole("button", { name: "Record adjustment" }));

    expect(
      await screen.findByText(
        "That adjustment would take stock below what is already reserved for open orders.",
      ),
    ).toBeInTheDocument();
  });
});

describe("/pricing", () => {
  const catalogue = {
    ...asAdmin,
    "GET /admin/products": () => page([ALMONDS, MAKHANA_DRAFT], 2),
    "GET /admin/businesses": () => page([BUSINESS_ANAND]),
  };

  const ladder = {
    ...catalogue,
    "GET /admin/pricing-tiers": () => page([TIER_SEGMENT, TIER_QUOTE_ONLY, TIER_BUSINESS], 3),
  };

  it("renders the ladder, with null meaning two different real things", async () => {
    mount("/pricing", ladder);

    const table = await screen.findByRole("table", {
      name: "Pricing tiers by product, band and business",
    });
    expect(screen.getByRole("heading", { name: "B2B pricing" })).toBeInTheDocument();

    // `pricePerKg: null` is brief §47's quote-required slab, not a missing price — rendering it as
    // ₹0 would claim the goods were free.
    expect(within(table).getByText("Quote required")).toBeInTheDocument();
    // `maxKg: null` is brief §16's open-ended "50kg+" top slab.
    expect(within(table).getByText("25 kg and above")).toBeInTheDocument();
    expect(within(table).getByText("10 – 24 kg")).toBeInTheDocument();

    // Rupees per kilo, straight off the wire.
    expect(within(table).getByText("₹720")).toBeInTheDocument();
    expect(within(table).getByText("₹655")).toBeInTheDocument();

    // Brief §31's four bands, and the customer-specific scope beside them.
    // Two rungs share the distributor band; the customer-specific one sits on the list band, which
    // is a legitimate row because a business-scoped rung is resolved by business and not by band.
    expect(within(table).getAllByText("Distributor")).toHaveLength(2);
    expect(within(table).getByText("List price")).toBeInTheDocument();
    expect(within(table).getByText("Anand Sweets & Namkeen")).toBeInTheDocument();
    expect(within(table).getAllByText("Everyone in the band").length).toBe(2);
  });

  it("says where MOQ lives, and that a tier cannot be deleted", async () => {
    mount("/pricing", ladder);

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    // Brief §31 lists MOQ on this screen; `products.moqKg` already has an editor, and a second
    // writer would be a second answer to the same question.
    expect(screen.getByText(/Brief §31's MOQ is a product field/)).toBeInTheDocument();
    expect(screen.getByText(/A tier cannot be deleted/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("carries the business sentinel through to the API, because a query string has no null", async () => {
    const { calls } = mount(`/pricing?businessId=none&segment=distributor`, ladder);

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/pricing-tiers"));
      expect(found).toBeDefined();
      return found;
    });
    expect(request?.url).toContain("businessId=none");
    expect(request?.url).toContain("segment=distributor");
  });

  it("sends an explicit null for the open-ended, quote-required slab", async () => {
    const user = userEvent.setup();
    const { calls } = mount("/pricing", {
      ...ladder,
      "POST /admin/pricing-tiers": () => TIER_QUOTE_ONLY,
    });

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    await user.click(screen.getByRole("button", { name: "New tier" }));

    // Scoped to the form: its controls repeat the filter bar's labels by design, and the form
    // carries an accessible name so "the Product select" is unambiguous.
    const form = await screen.findByRole("form", { name: "New pricing tier" });
    await user.type(within(form).getByLabelText("From (kg)"), "25");
    await user.click(within(form).getByLabelText(/Open-ended top slab/));
    await user.click(within(form).getByLabelText(/Quote required/));
    await user.click(within(form).getByRole("button", { name: "Add tier" }));

    const write = await waitFor(() => {
      const found = calls.find((call) => call.method === "POST");
      expect(found).toBeDefined();
      return found;
    });
    // `null`, not an omitted key: `@ValidateIf` on the DTO exists so an explicit null reaches the
    // handler, and `@IsOptional()` would have accepted it and thrown it away.
    expect(write?.body).toContain('"maxKg":null');
    expect(write?.body).toContain('"pricePerKg":null');
    expect(write?.body).toContain(`"productId":"${ALMONDS.id}"`);
  });

  it("renders which tier collided when the server refuses an overlap", async () => {
    const user = userEvent.setup();
    mount("/pricing", {
      ...ladder,
      // The real refusal, from `assertLadderIsWritable` under a `FOR UPDATE` lock on the product.
      "POST /admin/pricing-tiers": () =>
        apiError(
          409,
          "Another tier already covers part of that quantity range.",
          "PRICING_TIER_OVERLAP",
          {
            conflictingTierId: TIER_SEGMENT.id,
            conflictingMinKg: 10,
            conflictingMaxKg: 24,
            minKg: 20,
            maxKg: 30,
          },
        ),
    });

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    await user.click(screen.getByRole("button", { name: "New tier" }));

    const form = await screen.findByRole("form", { name: "New pricing tier" });
    await user.type(within(form).getByLabelText("From (kg)"), "20");
    await user.type(within(form).getByLabelText("To (kg)"), "30");
    await user.type(within(form).getByLabelText("Rate (₹ per kg)"), "700");
    await user.click(within(form).getByRole("button", { name: "Add tier" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Another tier already covers part of that range.");
    // Which one, not just that one exists: the operator has to know what to move.
    expect(alert).toHaveTextContent("The tier in the way runs from 10 kg to 24 kg.");
    // And why it is refused rather than resolved by row order.
    expect(alert).toHaveTextContent("snapshotted onto order items");
    // The row itself is marked, because a uuid in a message is not an answer an operator can act
    // on and a bare range still leaves them scanning the table for it.
    expect(screen.getByText("This is the tier in the way")).toBeInTheDocument();
  });

  it("opens an existing tier for editing with the product still changeable", async () => {
    const user = userEvent.setup();
    mount("/pricing", ladder);

    const table = await screen.findByRole("table", {
      name: "Pricing tiers by product, band and business",
    });
    await user.click(
      within(table).getByRole("button", {
        name: "Edit Premium California Almonds 10 – 24 kg",
      }),
    );

    const form = await screen.findByRole("form", { name: "Edit pricing tier" });
    expect(within(form).getByLabelText("From (kg)")).toHaveValue(10);
    expect(within(form).getByLabelText("Rate (₹ per kg)")).toHaveValue(720);
    // Movable on purpose: with no DELETE route, a rung on the wrong product is otherwise unfixable.
    expect(within(form).getByLabelText("Product")).toBeEnabled();
    expect(within(form).getByLabelText("Product")).toHaveValue(ALMONDS.id);
  });
});

describe("the filter bars", () => {
  it("empties the search box when the filters are cleared", async () => {
    const user = userEvent.setup();
    mount("/products?q=almond", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS]),
    });

    await screen.findByRole("table", { name: "Products, drafts included" });
    expect(screen.getByLabelText("Name or slug")).toHaveValue("almond");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    // The box is uncontrolled — it holds what was typed, not what is filtering — so without a key
    // tied to the URL it would keep the old text and read as a filter that failed to clear.
    await waitFor(() => {
      expect(screen.getByLabelText("Name or slug")).toHaveValue("");
    });
  });
});

describe("/pricing search hardening", () => {
  it("drops a filter value the API would reject by shape rather than sending it", async () => {
    const { calls } = mount("/pricing?productId=banana&businessId=also-not-a-uuid&bogus=1", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS]),
      "GET /admin/businesses": () => page([BUSINESS_ANAND]),
      "GET /admin/pricing-tiers": () => page([TIER_SEGMENT]),
    });

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/pricing-tiers"));
      expect(found).toBeDefined();
      return found;
    });
    expect(request?.url).not.toContain("banana");
    expect(request?.url).not.toContain("productId=");
    expect(request?.url).not.toContain("businessId=");
    expect(request?.url).not.toContain("bogus");
  });

  it("keeps the one sentinel the DTO checks before @IsUUID", async () => {
    const { calls } = mount("/pricing?businessId=none", {
      ...asAdmin,
      "GET /admin/products": () => page([ALMONDS]),
      "GET /admin/businesses": () => page([BUSINESS_ANAND]),
      "GET /admin/pricing-tiers": () => page([TIER_SEGMENT]),
    });

    await screen.findByRole("table", { name: "Pricing tiers by product, band and business" });
    const request = await waitFor(() => {
      const found = calls.find((call) => call.url.includes("/admin/pricing-tiers"));
      expect(found).toBeDefined();
      return found;
    });
    expect(request?.url).toContain("businessId=none");
  });
});
