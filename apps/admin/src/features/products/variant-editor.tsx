import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminProduct, AdminVariant, Channel } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import {
  createVariant,
  deleteVariant,
  updateVariant,
  type VariantInput,
} from "@/features/products/api/products";
import { entityInUse, type DeleteRefusal } from "@/features/products/api/refusals";
import { count, inr } from "@/lib/format";

/**
 * Brief §30's "Variants: weight, SKU, price, MRP, stock, MOQ" — the pack list, edited in place.
 *
 * Three things this deliberately does **not** offer, each because the server would refuse it:
 *
 * - **`lowStockThreshold` on an existing pack.** `UpdateVariantDto` excludes it: the threshold
 *   lives on the `Inventory` row, and `InventoryService` is the only writer that table's ledger
 *   invariant tolerates. It is settable exactly once, at creation, and changed afterwards through
 *   `PATCH /admin/inventory/:variantId/threshold` — the inventory screen. The add form below has
 *   the input; the edit form says where it went rather than rendering one that cannot save.
 * - **Opening stock.** A variant is created at zero and stock arrives through the audited
 *   inventory path, because `SUM(inventory_transactions.delta) = inventory.onHand` per variant is
 *   an invariant the backend asserts — a figure written straight into the column with no ledger
 *   row behind it would break it on the first pack anyone created.
 * - **Moving a pack to another product.** `UpdateVariantDto` has no `productId`: it would orphan
 *   the stock ledger against the wrong catalogue entry. Deactivate one and create another.
 *
 * `available` and `soldOut` are shown but not editable, for the same reason — they are `onHand -
 * reserved` and the contract's `variantSoldOut` over it, derived server-side so every client agrees.
 */

const CHANNELS: readonly Channel[] = ["retail", "bulk"];

function channelLabel(channel: Channel): string {
  return channel === "bulk" ? "B2B (bulk)" : "B2C (retail)";
}

interface VariantDraft {
  sku: string;
  size: string;
  grams: string;
  channel: Channel;
  price: string;
  mrp: string;
  moq: string;
  isActive: boolean;
  lowStockThreshold: string;
}

const EMPTY_DRAFT: VariantDraft = {
  sku: "",
  size: "",
  grams: "",
  channel: "retail",
  price: "",
  mrp: "",
  moq: "1",
  isActive: true,
  lowStockThreshold: "10",
};

function draftFrom(variant: AdminVariant): VariantDraft {
  return {
    sku: variant.sku,
    size: variant.size,
    grams: String(variant.grams),
    channel: variant.channel,
    // Rupees, straight off the wire and straight back onto it. Spec §8 converts once at the
    // mapper boundary and `CreateVariantDto` reads a body as the same boundary in reverse, so a
    // `/100` in either direction here would be the second one.
    price: String(variant.price),
    mrp: String(variant.mrp),
    moq: String(variant.moq),
    isActive: variant.isActive,
    lowStockThreshold: "",
  };
}

function parseChannel(value: string): Channel {
  return value === "bulk" ? "bulk" : "retail";
}

/** The shared half of the create and edit forms: everything but the threshold. */
function variantFields(draft: VariantDraft): Omit<VariantInput, "lowStockThreshold"> {
  return {
    sku: draft.sku.trim(),
    size: draft.size.trim(),
    grams: Number(draft.grams),
    channel: draft.channel,
    price: Number(draft.price),
    mrp: Number(draft.mrp),
    moq: Number(draft.moq),
    isActive: draft.isActive,
  };
}

function VariantFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: VariantDraft;
  onChange: (patch: Partial<VariantDraft>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="SKU" htmlFor={`${idPrefix}-sku`}>
        <Input
          id={`${idPrefix}-sku`}
          required
          minLength={2}
          maxLength={60}
          value={draft.sku}
          onChange={(event) => onChange({ sku: event.target.value })}
        />
      </Field>
      <Field label="Pack size" htmlFor={`${idPrefix}-size`}>
        <Input
          id={`${idPrefix}-size`}
          required
          maxLength={20}
          placeholder="1kg"
          value={draft.size}
          onChange={(event) => onChange({ size: event.target.value })}
        />
      </Field>
      <Field label="Grams" htmlFor={`${idPrefix}-grams`}>
        <Input
          id={`${idPrefix}-grams`}
          required
          type="number"
          min={1}
          step={1}
          value={draft.grams}
          onChange={(event) => onChange({ grams: event.target.value })}
        />
      </Field>
      <Field label="Channel" htmlFor={`${idPrefix}-channel`}>
        <Select
          id={`${idPrefix}-channel`}
          value={draft.channel}
          onChange={(event) => onChange({ channel: parseChannel(event.target.value) })}
        >
          {CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {channelLabel(channel)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Price (₹, ex-GST)" htmlFor={`${idPrefix}-price`}>
        <Input
          id={`${idPrefix}-price`}
          required
          type="number"
          min={0}
          step={0.01}
          value={draft.price}
          onChange={(event) => onChange({ price: event.target.value })}
        />
      </Field>
      <Field label="MRP (₹, inclusive)" htmlFor={`${idPrefix}-mrp`}>
        <Input
          id={`${idPrefix}-mrp`}
          required
          type="number"
          min={0}
          step={0.01}
          value={draft.mrp}
          onChange={(event) => onChange({ mrp: event.target.value })}
        />
      </Field>
      <Field label="MOQ (packs)" htmlFor={`${idPrefix}-moq`}>
        <Input
          id={`${idPrefix}-moq`}
          type="number"
          min={1}
          step={1}
          value={draft.moq}
          onChange={(event) => onChange({ moq: event.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 self-end pb-1.5 text-[12px] sm:col-span-2">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(event) => onChange({ isActive: event.target.checked })}
        />
        Offered for sale. Deactivating withdraws the pack without touching its stock ledger.
      </label>
    </div>
  );
}

export function VariantEditor({ product }: { product: AdminProduct }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariantDraft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<VariantDraft>(EMPTY_DRAFT);
  const [refusal, setRefusal] = useState<{ variantId: string; refusal: DeleteRefusal } | null>(
    null,
  );

  function refreshProduct() {
    void client.invalidateQueries({ queryKey: ["product", product.id] });
    void client.invalidateQueries({ queryKey: ["products"] });
    // A pack gained or withdrawn moves the stock screen's rows and the dashboard's Low Stock card.
    void client.invalidateQueries({ queryKey: ["inventory"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  }

  const create = useMutation({
    mutationFn: () =>
      createVariant(product.id, {
        ...variantFields(newDraft),
        ...(newDraft.lowStockThreshold.trim() === ""
          ? {}
          : { lowStockThreshold: Number(newDraft.lowStockThreshold) }),
      }),
    onSuccess: (variant) => {
      setAdding(false);
      setNewDraft(EMPTY_DRAFT);
      refreshProduct();
      toast.success(`${variant.sku} added. It starts at zero stock.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const save = useMutation({
    mutationFn: (variantId: string) => updateVariant(variantId, variantFields(draft)),
    onSuccess: (variant) => {
      setEditing(null);
      refreshProduct();
      toast.success(`${variant.sku} saved.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: (variantId: string) => deleteVariant(variantId),
    onSuccess: () => {
      setRefusal(null);
      setEditing(null);
      refreshProduct();
      toast.success("Pack deleted.");
    },
    onError: (error: unknown, variantId) => {
      const refused = entityInUse(error);
      if (refused !== null) {
        // Not a failure to report — the server has said which reference blocks the delete and what
        // to do instead. Rendered in place, beside the deactivation control that is the answer.
        setRefusal({ variantId, refusal: refused });
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const deactivate = useMutation({
    mutationFn: (variantId: string) => updateVariant(variantId, { isActive: false }),
    onSuccess: (variant) => {
      setRefusal(null);
      refreshProduct();
      toast.success(`${variant.sku} withdrawn from sale. Its stock and ledger are untouched.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  return (
    <Panel>
      <PanelHeader
        title="Packs"
        hint={`${count(product.variants.length)} ${product.variants.length === 1 ? "variant" : "variants"}`}
        action={
          <Button size="sm" variant="outline" onClick={() => setAdding((open) => !open)}>
            {adding ? "Cancel" : "Add a pack"}
          </Button>
        }
      />

      {adding && (
        <form
          className="border-border flex flex-col gap-3 border-b px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <VariantFields
            idPrefix="new-variant"
            draft={newDraft}
            onChange={(patch) => setNewDraft((previous) => ({ ...previous, ...patch }))}
          />
          <Field label="Low-stock threshold" htmlFor="new-variant-threshold" className="sm:w-48">
            <Input
              id="new-variant-threshold"
              type="number"
              min={0}
              step={1}
              value={newDraft.lowStockThreshold}
              onChange={(event) =>
                setNewDraft((previous) => ({ ...previous, lowStockThreshold: event.target.value }))
              }
            />
          </Field>
          <p className="text-muted-foreground text-[11px]">
            The threshold can only be set here, at creation. Changing it afterwards is a stock
            operation and lives on the Inventory screen. `0` is legal and means "warn me only when
            it is actually gone".
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Adding…" : "Add pack"}
            </Button>
          </div>
        </form>
      )}

      {product.variants.length === 0 ? (
        <Notice
          title="This product has no packs yet."
          body="Nothing can be bought until at least one is added — a product with no active variant reads as sold out on the storefront."
        />
      ) : (
        <TableWrap>
          <Table caption={`Packs of ${product.name}`}>
            <thead>
              <tr>
                <Th>SKU</Th>
                <Th>Pack</Th>
                <Th>Channel</Th>
                <Th numeric>Price</Th>
                <Th numeric>MRP</Th>
                <Th numeric>MOQ</Th>
                <Th numeric>Available</Th>
                <Th>State</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((variant) => (
                <Tr key={variant.id}>
                  <Td className="tnum font-medium">{variant.sku}</Td>
                  <Td>
                    {variant.size}
                    <span className="text-muted-foreground tnum"> · {count(variant.grams)}g</span>
                  </Td>
                  <Td>{variant.channel === "bulk" ? "B2B" : "B2C"}</Td>
                  <Td numeric>{inr(variant.price)}</Td>
                  <Td numeric>{inr(variant.mrp)}</Td>
                  <Td numeric>{count(variant.moq)}</Td>
                  <Td numeric>{count(variant.available)}</Td>
                  <Td>
                    {!variant.isActive ? (
                      <span className="text-muted-foreground">Withdrawn</span>
                    ) : variant.soldOut ? (
                      <span className="text-destructive">Sold out</span>
                    ) : (
                      <span className="text-leaf">On sale</span>
                    )}
                  </Td>
                  <Td>
                    <Button
                      size="sm"
                      variant="ghost"
                      // Named per row: a column of identical "Edit" buttons is one control repeated
                      // as far as a screen reader is concerned, and it is what lets a test reach
                      // the pack it means rather than the first one rendered.
                      aria-label={
                        editing === variant.id ? `Close ${variant.sku}` : `Edit ${variant.sku}`
                      }
                      onClick={() => {
                        setRefusal(null);
                        if (editing === variant.id) {
                          setEditing(null);
                          return;
                        }
                        setEditing(variant.id);
                        setDraft(draftFrom(variant));
                      }}
                    >
                      {editing === variant.id ? "Close" : "Edit"}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}

      {product.variants.map((variant) =>
        editing === variant.id ? (
          <form
            key={variant.id}
            className="border-border flex flex-col gap-3 border-t px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(variant.id);
            }}
          >
            <p className="text-[12px] font-semibold">Editing {variant.sku}</p>
            <VariantFields
              idPrefix={`variant-${variant.id}`}
              draft={draft}
              onChange={(patch) => setDraft((previous) => ({ ...previous, ...patch }))}
            />
            <p className="text-muted-foreground text-[11px]">
              Stock and its low-stock threshold are not editable here — they belong to the stock
              ledger, which the Inventory screen writes. This pack currently has{" "}
              {count(variant.available)} available.
            </p>

            {refusal?.variantId === variant.id && (
              <Notice
                tone="error"
                title="This pack cannot be deleted."
                body={
                  refusal.refusal.message +
                  (refusal.refusal.onHand !== undefined
                    ? ` It still holds ${count(refusal.refusal.onHand)} packs.`
                    : refusal.refusal.orderItems !== undefined
                      ? ` ${count(refusal.refusal.orderItems)} order lines reference it.`
                      : refusal.refusal.inventoryTransactions !== undefined
                        ? ` ${count(refusal.refusal.inventoryTransactions)} stock movements reference it.`
                        : "")
                }
                action={
                  variant.isActive ? (
                    <Button
                      variant="outline"
                      disabled={deactivate.isPending}
                      onClick={() => deactivate.mutate(variant.id)}
                    >
                      {deactivate.isPending ? "Withdrawing…" : "Withdraw from sale instead"}
                    </Button>
                  ) : undefined
                }
              />
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save pack"}
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(variant.id)}
              >
                {remove.isPending ? "Deleting…" : "Delete pack"}
              </Button>
            </div>
          </form>
        ) : null,
      )}
    </Panel>
  );
}
