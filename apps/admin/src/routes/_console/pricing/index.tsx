import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminPricingTier, CustomerSegment } from "@/contract";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import {
  BUSINESS_NONE,
  BUSINESS_OPTIONS_LIMIT,
  createPricingTier,
  fetchBusinessOptions,
  fetchPricingTiers,
  PRICING_PAGE_SIZE,
  pricingTierOverlap,
  updatePricingTier,
  type PricingTierInput,
  type TierOverlap,
} from "@/features/pricing/api/pricing";
import { parseSegment, SEGMENTS, segmentLabel } from "@/features/pricing/segments";
import { TierForm } from "@/features/pricing/tier-form";
import { fetchProducts, PRODUCTS_MAX_PAGE_SIZE } from "@/features/products/api/products";
import { count, dateTime, inr } from "@/lib/format";

/**
 * `/pricing` — brief §31's B2B ladder: quantity tiers per product, per band, and per business.
 *
 * **An overlapping rung is refused `409 PRICING_TIER_OVERLAP` and the refusal is rendered, not
 * reported.** Two rows covering one quantity make `resolveTiers`' answer depend on row order, and
 * the resolved rate is snapshotted onto order items — so this is a money disagreement rather than a
 * display one. The server names the rung in the way; this screen shows which it was.
 *
 * **MOQ is on brief §31's list and is not on this screen.** `products.moqKg` is a product field,
 * already editable at `/products/$id`. A second writer would be a second answer to "what is the
 * minimum for this product", so the screen points at the product instead of duplicating the input.
 *
 * **There is no delete.** §6.4 gives this resource three verbs; a rung created against the wrong
 * product is *moved* rather than deleted, which is why the form leaves the product editable.
 */

interface PricingSearch {
  productId?: string;
  segment?: CustomerSegment;
  /** A business uuid, or `none` for the rungs scoped to nobody in particular. */
  businessId?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/pricing/")({
  validateSearch: (search: Record<string, unknown>): PricingSearch => {
    const productId = search["productId"];
    const segment = parseSegment(search["segment"]);
    const businessId = search["businessId"];
    const page = Number(search["page"]);

    return {
      ...(typeof productId === "string" && UUID.test(productId) ? { productId } : {}),
      ...(segment === undefined ? {} : { segment }),
      // `none` is the sentinel the DTO checks *before* `@IsUUID`, so it is legal here and nowhere
      // else in this app.
      ...(typeof businessId === "string" && (businessId === BUSINESS_NONE || UUID.test(businessId))
        ? { businessId }
        : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: PricingScreen,
});

/**
 * A uuid as `@IsUUID()` will accept it.
 *
 * Narrowed here because these two are the only search parameters in this app that are forwarded
 * **verbatim into a query string the server validates by shape**: everything else is either matched
 * against a contract tuple, or used to find a row this screen already holds. A hand-edited
 * `?productId=banana` would otherwise be answered `productId must be a UUID`, which is legible but
 * is still a failed screen where dropping the value gives an unfiltered one.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `10 – 24 kg`, or `25 kg and above` for the open-ended top slab. */
function rangeLabel(tier: AdminPricingTier): string {
  const from = count(tier.minKg);
  return tier.maxKg === null ? `${from} kg and above` : `${from} – ${count(tier.maxKg)} kg`;
}

function PricingScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [overlap, setOverlap] = useState<TierOverlap | null>(null);

  const page = search.page ?? 1;

  const tiers = useQuery({
    queryKey: ["pricing-tiers", search],
    queryFn: ({ signal }) =>
      fetchPricingTiers({ ...search, page, limit: PRICING_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  /**
   * The product picker, capped at the endpoint's own ceiling of 60. `AdminProductQueryDto` caps
   * `limit` at 60 and the service clamps too, so asking for more would be a 400 rather than a
   * longer list — the screen says so below when the catalogue outgrows one page.
   */
  const products = useQuery({
    queryKey: ["products", { limit: PRODUCTS_MAX_PAGE_SIZE }],
    queryFn: ({ signal }) => fetchProducts({ limit: PRODUCTS_MAX_PAGE_SIZE }, signal),
  });

  const businesses = useQuery({
    queryKey: ["business-options"],
    queryFn: ({ signal }) => fetchBusinessOptions(signal),
  });

  function setFilter(patch: Partial<PricingSearch>) {
    void navigate({
      search: (previous: PricingSearch): PricingSearch => {
        const next: PricingSearch = { ...previous, ...patch };
        delete next.page;
        if (next.productId === undefined || next.productId === "") delete next.productId;
        if (next.segment === undefined) delete next.segment;
        if (next.businessId === undefined || next.businessId === "") delete next.businessId;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: PricingSearch): PricingSearch => {
        const updated: PricingSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  function close() {
    setCreating(false);
    setEditing(null);
    setOverlap(null);
  }

  function refresh() {
    void client.invalidateQueries({ queryKey: ["pricing-tiers"] });
    // The `DEFAULT` ladder is carried on `AdminProduct.bulkTiers`, so a rung changes what the
    // product detail shows.
    void client.invalidateQueries({ queryKey: ["products"] });
  }

  function onWriteError(error: unknown) {
    const clash = pricingTierOverlap(error);
    if (clash !== null) {
      // The normal case: the server has already worked out which rung is in the way.
      setOverlap(clash);
      return;
    }
    setOverlap(null);
    toast.error(errorMessage(error));
  }

  const create = useMutation({
    mutationFn: (input: PricingTierInput) => createPricingTier(input),
    onSuccess: (tier) => {
      close();
      refresh();
      toast.success(`Tier added to ${tier.productName}.`);
    },
    onError: onWriteError,
  });

  const save = useMutation({
    mutationFn: (variables: { id: string; input: PricingTierInput }) =>
      updatePricingTier(variables.id, variables.input),
    onSuccess: (tier) => {
      close();
      refresh();
      toast.success(`Tier on ${tier.productName} saved.`);
    },
    onError: onWriteError,
  });

  const rows = tiers.data?.items ?? [];
  const productOptions = products.data?.items ?? [];
  const businessOptions = businesses.data?.items ?? [];
  const editingTier = rows.find((row) => row.id === editing);
  const total = tiers.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PRICING_PAGE_SIZE));
  const isFiltered =
    search.productId !== undefined ||
    search.segment !== undefined ||
    search.businessId !== undefined;

  return (
    <Page
      title="B2B pricing"
      description={
        tiers.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "tier" : "tiers"}${isFiltered ? " matching these filters" : ""}`
      }
      actions={
        <Button
          onClick={() => {
            if (creating) {
              close();
              return;
            }
            setEditing(null);
            setOverlap(null);
            setCreating(true);
          }}
        >
          {creating ? "Cancel" : "New tier"}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Product" htmlFor="tier-filter-product" className="w-64">
            <Select
              id="tier-filter-product"
              value={search.productId ?? ""}
              onChange={(event) => setFilter({ productId: event.target.value })}
            >
              <option value="">All products</option>
              {productOptions.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Price band" htmlFor="tier-filter-segment" className="w-44">
            <Select
              id="tier-filter-segment"
              value={search.segment ?? ""}
              onChange={(event) => setFilter({ segment: parseSegment(event.target.value) })}
            >
              <option value="">All bands</option>
              {SEGMENTS.map((segment) => (
                <option key={segment} value={segment}>
                  {segmentLabel(segment)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Business" htmlFor="tier-filter-business" className="w-56">
            <Select
              id="tier-filter-business"
              value={search.businessId ?? ""}
              onChange={(event) => setFilter({ businessId: event.target.value })}
            >
              <option value="">Any scope</option>
              {/*
                A sentinel, and the only one on this endpoint: a query string has no null, so
                "the rungs belonging to nobody in particular" cannot be asked without one.
              */}
              <option value={BUSINESS_NONE}>No business (band ladders)</option>
              {businessOptions.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.companyName}
                </option>
              ))}
            </Select>
          </Field>

          {isFiltered && (
            <Button
              variant="ghost"
              onClick={() => void navigate({ search: {} })}
              className="mb-0.5"
            >
              Clear filters
            </Button>
          )}
        </Panel>

        {(creating || editingTier !== undefined) && (
          <TierForm
            key={editingTier?.id ?? "new"}
            products={productOptions}
            businesses={businessOptions}
            {...(editingTier === undefined ? {} : { tier: editingTier })}
            pending={create.isPending || save.isPending}
            error={
              create.isError
                ? errorMessage(create.error)
                : save.isError
                  ? errorMessage(save.error)
                  : undefined
            }
            overlap={overlap}
            onSubmit={(input) => {
              setOverlap(null);
              if (editingTier === undefined) create.mutate(input);
              else save.mutate({ id: editingTier.id, input });
            }}
            onCancel={close}
          />
        )}

        <Panel>
          {tiers.isPending ? (
            <Loading label="Loading pricing tiers" />
          ) : tiers.isError ? (
            <Notice
              tone="error"
              title="Pricing tiers could not be loaded."
              body={errorMessage(tiers.error)}
              action={
                <Button variant="outline" onClick={() => void tiers.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title={isFiltered ? "No tiers match these filters." : "No pricing tiers yet."}
              body={
                isFiltered
                  ? "Clear the filters to see every ladder."
                  : "Without a tier, a bulk enquiry falls through to the product's own ladder or to a quote."
              }
              action={
                isFiltered ? (
                  <Button variant="outline" onClick={() => void navigate({ search: {} })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableWrap>
              <Table caption="Pricing tiers by product, band and business">
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Quantity</Th>
                    <Th numeric>Rate per kg</Th>
                    <Th>Band</Th>
                    <Th>Scope</Th>
                    <Th>Updated</Th>
                    <Th>{""}</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((tier) => (
                    <Tr
                      key={tier.id}
                      // The rung the server named as the one in the way. Marking the row is what
                      // turns `conflictingTierId` into an answer an operator can act on: a uuid in
                      // a message is not one, and the range alone still leaves them scanning.
                      className={
                        overlap?.conflictingTierId === tier.id
                          ? "bg-destructive/8 outline-destructive/40 outline outline-offset-[-1px]"
                          : undefined
                      }
                    >
                      <Td>
                        <Link
                          to="/products/$id"
                          params={{ id: tier.productId }}
                          className="text-primary font-medium hover:underline"
                        >
                          {tier.productName}
                        </Link>
                        <span className="text-muted-foreground block text-[11px]">
                          {tier.productSlug}
                        </span>
                      </Td>
                      <Td className="tnum">
                        {rangeLabel(tier)}
                        {overlap?.conflictingTierId === tier.id && (
                          <span className="text-destructive block text-[11px] font-medium">
                            This is the tier in the way
                          </span>
                        )}
                      </Td>
                      <Td numeric>
                        {/*
                          `null` is brief §47's quote-required slab, not a missing price. Rendering
                          it as ₹0 would claim the goods were free.
                        */}
                        {tier.pricePerKg === null ? (
                          <span className="text-muted-foreground">Quote required</span>
                        ) : (
                          inr(tier.pricePerKg)
                        )}
                      </Td>
                      <Td>{segmentLabel(tier.segment)}</Td>
                      <Td>
                        {tier.companyName ?? (
                          <span className="text-muted-foreground">Everyone in the band</span>
                        )}
                      </Td>
                      <Td className="text-muted-foreground tnum whitespace-nowrap">
                        {dateTime(tier.updatedAt)}
                      </Td>
                      <Td>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={
                            editing === tier.id
                              ? `Close ${tier.productName} ${rangeLabel(tier)}`
                              : `Edit ${tier.productName} ${rangeLabel(tier)}`
                          }
                          onClick={() => {
                            setCreating(false);
                            setOverlap(null);
                            setEditing(editing === tier.id ? null : tier.id);
                          }}
                        >
                          {editing === tier.id ? "Close" : "Edit"}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {tiers.data !== undefined && rows.length > 0 && (
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

          <div className="border-border text-muted-foreground flex flex-col gap-1 border-t px-3 py-2 text-[11px]">
            <p>
              {/*
                Brief §31 asks for MOQ on this screen. It is a product column with an editor
                already, and a second writer would be a second answer to the same question.
              */}
              Brief §31's MOQ is a product field —{" "}
              <Link to="/products" className="text-primary hover:underline">
                edit it on the product
              </Link>
              , not here, so there is only ever one answer to a product's minimum.
            </p>
            <p>
              A tier cannot be deleted; there is no such route. A rung created against the wrong
              product is <em>moved</em> instead, which re-runs the overlap check against the ladder
              it lands on.
            </p>
            {products.data !== undefined && products.data.total > PRODUCTS_MAX_PAGE_SIZE && (
              <p>
                The product pickers list the first {count(PRODUCTS_MAX_PAGE_SIZE)} of{" "}
                {count(products.data.total)} products — the endpoint's own ceiling.
              </p>
            )}
            {businesses.data !== undefined && businesses.data.total > BUSINESS_OPTIONS_LIMIT && (
              <p>
                The business picker lists the first {count(BUSINESS_OPTIONS_LIMIT)} of{" "}
                {count(businesses.data.total)} businesses.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </Page>
  );
}
