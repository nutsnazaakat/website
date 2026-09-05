import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  fetchInventory,
  INVENTORY_PAGE_SIZE,
  type StockStatusFilter,
} from "@/features/inventory/api/inventory";
import { StockPanel } from "@/features/inventory/stock-panel";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateTime } from "@/lib/format";

/**
 * `/inventory` — brief §32: current, reserved, available, low, out, and the history behind each.
 *
 * **It opens on the low/out filter, not on everything.** An operator comes to this screen with one
 * question — what do I need to order? — and the endpoint answers it directly: `?status=low` filters
 * in SQL *before* `LIMIT`, and the rows come back ordered by `available` ascending, so the worst of
 * it is the top of page 1. Defaulting to the whole catalogue would bury the answer under
 * twenty-seven healthy rows.
 *
 * `low` **includes** `out` — spec §12's rule is `available <= lowStockThreshold` and a threshold is
 * never negative — which is why the filter is one three-way control rather than two checkboxes.
 *
 * `?variant=` carries which row's ledger is open, so a stock question can be sent to a colleague as
 * a link rather than as directions.
 */

type StatusChoice = "low" | "out" | "all";

/** The default, applied when the parameter is absent. See the docblock: this screen has a job. */
const DEFAULT_STATUS: StatusChoice = "low";

interface InventorySearch {
  q?: string;
  status?: StatusChoice;
  variant?: string;
  page?: number;
}

/**
 * Narrowed by comparison rather than by an assertion: this value arrives from the address bar, and
 * `value as StatusChoice` would be a claim about data this app did not produce. `statuses.ts` makes
 * the same argument for order statuses.
 */
function parseStatus(value: unknown): StatusChoice | undefined {
  if (value === "low" || value === "out" || value === "all") return value;
  return undefined;
}

export const Route = createFileRoute("/_console/inventory/")({
  validateSearch: (search: Record<string, unknown>): InventorySearch => {
    const q = search["q"];
    const status = parseStatus(search["status"]);
    const variant = search["variant"];
    const page = Number(search["page"]);

    return {
      ...(typeof q === "string" && q.trim() !== "" ? { q: q.slice(0, 200) } : {}),
      ...(status === undefined ? {} : { status }),
      ...(typeof variant === "string" && variant !== "" ? { variant: variant.slice(0, 80) } : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: InventoryScreen,
});

function InventoryScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const status = search.status ?? DEFAULT_STATUS;
  const page = search.page ?? 1;

  /**
   * `all` is this screen's word, not the API's. `InventoryQueryDto` accepts `low` and `out` and
   * nothing else, so "every stock position" is the *absence* of the parameter — sending
   * `status=all` would be a 400 under `forbidNonWhitelisted`, not an unfiltered list.
   */
  const apiStatus: StockStatusFilter | undefined = status === "all" ? undefined : status;

  const inventory = useQuery({
    queryKey: ["inventory", { q: search.q, status, page }],
    queryFn: ({ signal }) =>
      fetchInventory(
        {
          ...(search.q === undefined ? {} : { q: search.q }),
          ...(apiStatus === undefined ? {} : { status: apiStatus }),
          page,
          limit: INVENTORY_PAGE_SIZE,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  function setFilter(patch: Partial<InventorySearch>) {
    void navigate({
      search: (previous: InventorySearch): InventorySearch => {
        const next: InventorySearch = { ...previous, ...patch };
        delete next.page;
        // A filter change can leave the open row outside the list. Closing it is the honest
        // outcome — keeping a panel open for a row the table no longer shows reads as a bug.
        delete next.variant;
        if (next.q === undefined || next.q === "") delete next.q;
        if (next.status === undefined) delete next.status;
        return next;
      },
    });
  }

  function openVariant(variantId: string | null) {
    void navigate({
      search: (previous: InventorySearch): InventorySearch => {
        const next: InventorySearch = { ...previous };
        if (variantId === null) delete next.variant;
        else next.variant = variantId;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: InventorySearch): InventorySearch => {
        const updated: InventorySearch = { ...previous };
        delete updated.variant;
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const rows = inventory.data?.items ?? [];
  const open = rows.find((row) => row.variantId === search.variant);
  const total = inventory.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE));

  return (
    <Page
      title="Inventory"
      description={
        inventory.data === undefined
          ? "Loading…"
          : status === "all"
            ? `${count(total)} stock ${total === 1 ? "position" : "positions"}`
            : status === "out"
              ? `${count(total)} out of stock`
              : `${count(total)} at or below their threshold`
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="SKU or product" htmlFor="stock-q" className="w-56">
            <Input
              // Remounted when the URL's `q` changes, because this input is *uncontrolled* — it
              // holds what was typed rather than what is filtering. Without the key, "Clear
              // filters" would empty the query string and leave the old text sitting in the box,
              // which reads as a filter that failed to clear.
              key={search.q ?? ""}
              id="stock-q"
              maxLength={200}
              placeholder="PCA-500G"
              defaultValue={search.q ?? ""}
              onBlur={(event) => setFilter({ q: event.target.value.trim() })}
              onKeyDown={(event) => {
                if (event.key === "Enter") setFilter({ q: event.currentTarget.value.trim() });
              }}
            />
          </Field>

          <Field label="Stock position" htmlFor="stock-status" className="w-52">
            <Select
              id="stock-status"
              value={status}
              onChange={(event) => setFilter({ status: parseStatus(event.target.value) })}
            >
              <option value="low">Needs ordering (low and out)</option>
              <option value="out">Out of stock only</option>
              <option value="all">Every stock position</option>
            </Select>
          </Field>

          <p className="text-muted-foreground mb-1.5 ml-auto max-w-md text-[11px]">
            Low means <span className="tnum">available ≤ threshold</span>, so it already includes
            everything at zero. Withdrawn packs are listed too — stock does not stop existing
            because a pack stopped being offered.
          </p>
        </Panel>

        {open !== undefined && (
          <StockPanel key={open.variantId} row={open} onClose={() => openVariant(null)} />
        )}

        <Panel>
          {inventory.isPending ? (
            <Loading label="Loading stock" />
          ) : inventory.isError ? (
            <Notice
              tone="error"
              title="Stock could not be loaded."
              body={errorMessage(inventory.error)}
              action={
                <Button variant="outline" onClick={() => void inventory.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title={
                status === "out"
                  ? "Nothing is out of stock."
                  : status === "low"
                    ? "Nothing needs ordering."
                    : "There is no stock to show."
              }
              body={
                status === "all"
                  ? "A stock row is created with each pack, so this is empty only while the catalogue is."
                  : "Every pack is above its low-stock threshold."
              }
              action={
                status === "all" ? undefined : (
                  <Button variant="outline" onClick={() => setFilter({ status: "all" })}>
                    Show every stock position
                  </Button>
                )
              }
            />
          ) : (
            <TableWrap>
              <Table caption="Stock, most urgent first">
                <thead>
                  <tr>
                    <Th>SKU</Th>
                    <Th>Product</Th>
                    <Th>Pack</Th>
                    <Th numeric>Current</Th>
                    <Th numeric>Reserved</Th>
                    <Th numeric>Available</Th>
                    <Th numeric>Threshold</Th>
                    <Th>Position</Th>
                    <Th>Row changed</Th>
                    <Th>{""}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Tr key={row.variantId}>
                      <Td className="tnum font-medium">{row.sku}</Td>
                      <Td className="max-w-56 truncate">{row.productName}</Td>
                      <Td className="text-muted-foreground">{row.size}</Td>
                      <Td numeric>{count(row.onHand)}</Td>
                      <Td numeric>{count(row.reserved)}</Td>
                      <Td numeric>{count(row.available)}</Td>
                      <Td numeric>{count(row.lowStockThreshold)}</Td>
                      <Td>
                        <span className="flex flex-col gap-0.5">
                          <span
                            className={
                              row.outOfStock
                                ? "bg-destructive/12 text-destructive w-fit rounded px-1.5 py-0.5 text-[11px] font-medium"
                                : row.low
                                  ? "bg-gold/25 text-gold-foreground dark:text-gold w-fit rounded px-1.5 py-0.5 text-[11px] font-medium"
                                  : "bg-leaf/15 text-leaf w-fit rounded px-1.5 py-0.5 text-[11px] font-medium"
                            }
                          >
                            {row.outOfStock ? "Out of stock" : row.low ? "Low" : "In stock"}
                          </span>
                          {!row.isActive && (
                            <span className="text-muted-foreground text-[10px]">
                              Pack withdrawn — not worth reordering
                            </span>
                          )}
                        </span>
                      </Td>
                      <Td
                        className="text-muted-foreground tnum whitespace-nowrap"
                        // Not "when stock last moved": `inventory.updatedAt` is an
                        // `@UpdateDateColumn`, so a threshold correction bumps it having moved
                        // nothing. The ledger is the answer to when and why.
                        title="When this stock row last changed — a threshold edit bumps it too"
                      >
                        {dateTime(row.updatedAt)}
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="ghost"
                          // Named per row: a column of identical "Adjust" buttons is one control
                          // repeated as far as a screen reader is concerned.
                          aria-label={
                            search.variant === row.variantId
                              ? `Close ${row.sku}`
                              : `Adjust ${row.sku}`
                          }
                          onClick={() =>
                            openVariant(search.variant === row.variantId ? null : row.variantId)
                          }
                        >
                          {search.variant === row.variantId ? "Close" : "Adjust"}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {inventory.data !== undefined && rows.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-muted-foreground tnum text-[11px]">
                Page {count(page)} of {count(lastPage)} · {count(total)} in total
              </p>
              <div className="flex gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= lastPage}
                  onClick={() => goToPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </Page>
  );
}
