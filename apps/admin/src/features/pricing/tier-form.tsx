import { useState, type FormEvent } from "react";
import type { AdminBusinessSummary, AdminPricingTier, AdminProduct } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice, Panel, PanelHeader } from "@/components/ui/panel";
import type { PricingTierInput, TierOverlap } from "@/features/pricing/api/pricing";
import { parseSegment, SEGMENTS, segmentLabel } from "@/features/pricing/segments";
import { inr } from "@/lib/format";

/**
 * One rung of brief §31's ladder, created or edited.
 *
 * **Two of its fields are meaningfully nullable and each gets a checkbox rather than an empty
 * box.** `maxKg: null` is brief §16's open-ended "50kg+" slab and `pricePerKg: null` is brief §47's
 * quote-required one; a blank number input cannot distinguish "unset" from "deliberately null", and
 * the DTO's `@ValidateIf` exists precisely so an explicit `null` reaches the handler.
 *
 * **The product is editable even when editing.** `UpdatePricingTierDto` inherits `productId`
 * deliberately: this resource has no `DELETE`, so a rung created against the wrong product would
 * otherwise be unfixable. Moving one re-runs the overlap check against the destination ladder.
 */

interface Draft {
  productId: string;
  minKg: string;
  maxKg: string;
  openEnded: boolean;
  pricePerKg: string;
  quoteRequired: boolean;
  segment: string;
  businessId: string;
}

function draftFrom(tier: AdminPricingTier | undefined, fallbackProductId: string): Draft {
  if (tier === undefined) {
    return {
      productId: fallbackProductId,
      minKg: "",
      maxKg: "",
      openEnded: false,
      pricePerKg: "",
      quoteRequired: false,
      segment: "default",
      businessId: "",
    };
  }
  return {
    productId: tier.productId,
    minKg: String(tier.minKg),
    maxKg: tier.maxKg === null ? "" : String(tier.maxKg),
    openEnded: tier.maxKg === null,
    // Rupees per kilo, off the wire and back onto it. Spec §8 converts at the mapper boundary and
    // the DTO reads a body as the same boundary in reverse.
    pricePerKg: tier.pricePerKg === null ? "" : String(tier.pricePerKg),
    quoteRequired: tier.pricePerKg === null,
    segment: tier.segment,
    businessId: tier.businessId ?? "",
  };
}

export function TierForm({
  products,
  businesses,
  tier,
  pending,
  error,
  overlap,
  onSubmit,
  onCancel,
}: {
  products: readonly AdminProduct[];
  businesses: readonly AdminBusinessSummary[];
  tier?: AdminPricingTier;
  pending: boolean;
  error?: string | undefined;
  overlap?: TierOverlap | null;
  onSubmit: (input: PricingTierInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(tier, products[0]?.id ?? ""));

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      productId: draft.productId,
      minKg: Number(draft.minKg),
      // `null` sent explicitly, not omitted: it is the open-ended top slab, and an omitted field on
      // a PATCH means "leave unchanged".
      maxKg: draft.openEnded ? null : Number(draft.maxKg),
      pricePerKg: draft.quoteRequired ? null : Number(draft.pricePerKg),
      ...(parseSegment(draft.segment) === undefined
        ? {}
        : { segment: parseSegment(draft.segment) }),
      businessId: draft.businessId === "" ? null : draft.businessId,
    });
  }

  const idPrefix = tier === undefined ? "new-tier" : `tier-${tier.id}`;

  return (
    <Panel>
      <PanelHeader
        title={tier === undefined ? "New pricing tier" : "Editing a tier"}
        hint={tier === undefined ? "Brief §31" : tier.productName}
        action={
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        }
      />
      {/*
        Named, which gives the element `role="form"` and therefore an identity. It matters here more
        than on the other screens: this form's controls repeat the filter bar's labels — Product,
        Price band, Business — and without a name on the region, "the Product select" is ambiguous
        to a screen-reader user and to a test alike.
      */}
      <form
        aria-label={tier === undefined ? "New pricing tier" : "Edit pricing tier"}
        className="flex flex-col gap-3 px-3 py-3"
        onSubmit={submit}
      >
        {overlap != null && (
          <Notice
            tone="error"
            title="Another tier already covers part of that range."
            body={`${overlap.message} The tier in the way runs from ${String(overlap.conflictingMinKg ?? "?")} kg to ${
              overlap.conflictingMaxKg === null
                ? "open-ended"
                : `${String(overlap.conflictingMaxKg)} kg`
            }. Two rungs over one quantity would make the resolved rate depend on row order — and that rate is snapshotted onto order items, so it is a money disagreement rather than a display one.`}
          />
        )}
        {error !== undefined && overlap == null && (
          <Notice tone="error" title="That could not be saved." body={error} />
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Product" htmlFor={`${idPrefix}-product`} className="sm:col-span-2">
            <Select
              id={`${idPrefix}-product`}
              required
              value={draft.productId}
              onChange={(event) => set("productId", event.target.value)}
            >
              <option value="">Choose a product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="From (kg)" htmlFor={`${idPrefix}-min`}>
            <Input
              id={`${idPrefix}-min`}
              required
              type="number"
              min={0}
              max={10_000}
              step={0.01}
              value={draft.minKg}
              onChange={(event) => set("minKg", event.target.value)}
            />
          </Field>

          <Field label="To (kg)" htmlFor={`${idPrefix}-max`}>
            <Input
              id={`${idPrefix}-max`}
              required={!draft.openEnded}
              disabled={draft.openEnded}
              type="number"
              min={0}
              max={10_000}
              step={0.01}
              value={draft.openEnded ? "" : draft.maxKg}
              onChange={(event) => set("maxKg", event.target.value)}
            />
          </Field>

          <label className="flex items-center gap-2 text-[12px] sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.openEnded}
              onChange={(event) => set("openEnded", event.target.checked)}
            />
            Open-ended top slab — brief §16's "50 kg+". Sends no upper bound at all.
          </label>

          <Field label="Rate (₹ per kg)" htmlFor={`${idPrefix}-price`}>
            <Input
              id={`${idPrefix}-price`}
              required={!draft.quoteRequired}
              disabled={draft.quoteRequired}
              type="number"
              min={0}
              max={1_000_000}
              step={0.01}
              value={draft.quoteRequired ? "" : draft.pricePerKg}
              onChange={(event) => set("pricePerKg", event.target.value)}
            />
          </Field>

          <Field label="Price band" htmlFor={`${idPrefix}-segment`}>
            <Select
              id={`${idPrefix}-segment`}
              value={draft.segment}
              onChange={(event) => set("segment", event.target.value)}
            >
              {SEGMENTS.map((segment) => (
                <option key={segment} value={segment}>
                  {segmentLabel(segment)}
                </option>
              ))}
            </Select>
          </Field>

          <label className="flex items-center gap-2 text-[12px] sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.quoteRequired}
              onChange={(event) => set("quoteRequired", event.target.checked)}
            />
            Quote required — brief §47. The bulk calculator answers{" "}
            <span className="tnum">quoteRequired: true</span> for this slab and routes the enquiry
            to the RFQ form instead of pricing it.
          </label>

          <Field
            label="Business (optional)"
            htmlFor={`${idPrefix}-business`}
            className="sm:col-span-2"
          >
            <Select
              id={`${idPrefix}-business`}
              value={draft.businessId}
              onChange={(event) => set("businessId", event.target.value)}
            >
              <option value="">Everyone in the band above</option>
              {businesses.map((business) => (
                <option key={business.id} value={business.id}>
                  {business.companyName}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <p className="text-muted-foreground text-[11px]">
          {/*
            The resolver's own rule, said where it matters: a business-scoped rung is resolved by
            `businessId` alone and never by its band, which is why a `List price` rung scoped to one
            business is a legitimate row rather than a contradiction.
          */}
          A rung scoped to a business is resolved for that business whatever its band, so its price
          band is only a label there. Left as "everyone in the band above", it applies to every
          business in that band.
        </p>

        <div className="flex items-center gap-2">
          <Button type="submit" disabled={pending || draft.productId === ""}>
            {pending ? "Saving…" : tier === undefined ? "Add tier" : "Save tier"}
          </Button>
          {!draft.quoteRequired && draft.pricePerKg !== "" && (
            <p className="text-muted-foreground tnum text-[11px]">
              {inr(Number(draft.pricePerKg))} per kg
            </p>
          )}
        </div>
      </form>
    </Panel>
  );
}
