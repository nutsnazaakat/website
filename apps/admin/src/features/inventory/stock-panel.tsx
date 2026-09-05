import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminInventoryRow } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  adjustStock,
  fetchStockLedger,
  INVENTORY_PAGE_SIZE,
  setStockThreshold,
} from "@/features/inventory/api/inventory";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateTime } from "@/lib/format";

/**
 * One variant's stock: the two writes, and brief §32's history beneath them.
 *
 * **The two writes are separate on purpose and the screen says why.** An adjustment moves stock and
 * writes an append-only ledger row; a threshold change moves nothing, writes **no** ledger row, and
 * writes an audit row instead. Presenting them as one form with an optional threshold field would
 * suggest they are the same kind of act, and an operator correcting a threshold would go looking for
 * the ledger entry it did not make.
 */
export function StockPanel({ row, onClose }: { row: AdminInventoryRow; onClose: () => void }) {
  const client = useQueryClient();
  const [ledgerPage, setLedgerPage] = useState(1);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [threshold, setThreshold] = useState(String(row.lowStockThreshold));

  const ledger = useQuery({
    queryKey: ["stock-ledger", row.variantId, ledgerPage],
    queryFn: ({ signal }) =>
      fetchStockLedger(row.variantId, { page: ledgerPage, limit: INVENTORY_PAGE_SIZE }, signal),
    placeholderData: keepPreviousData,
  });

  function refresh() {
    void client.invalidateQueries({ queryKey: ["inventory"] });
    void client.invalidateQueries({ queryKey: ["stock-ledger", row.variantId] });
    // The Low Stock card and the product's `available`/`soldOut` both move with this.
    void client.invalidateQueries({ queryKey: ["dashboard"] });
    void client.invalidateQueries({ queryKey: ["product", row.productId] });
    void client.invalidateQueries({ queryKey: ["products"] });
  }

  const adjust = useMutation({
    mutationFn: () => adjustStock(row.variantId, { delta: Number(delta), reason: reason.trim() }),
    onSuccess: (result) => {
      setDelta("");
      setReason("");
      refresh();
      // The server's figure, not the arithmetic this screen could have done: the ledger's
      // `balanceAfter` is read back off the column rather than computed as `before + delta`.
      toast.success(`Stock adjusted. ${count(result.onHand)} now on hand.`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const saveThreshold = useMutation({
    mutationFn: () => setStockThreshold(row.variantId, Number(threshold)),
    onSuccess: (updated) => {
      refresh();
      toast.success(
        `Low-stock threshold is now ${count(updated.lowStockThreshold)}. No stock moved, so nothing was written to the ledger.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const total = ledger.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE));
  const parsedDelta = Number(delta);
  const deltaIsUsable = delta.trim() !== "" && Number.isInteger(parsedDelta) && parsedDelta !== 0;

  return (
    <Panel>
      <PanelHeader
        title={`${row.sku} · ${row.productName}`}
        hint={`${count(row.available)} available of ${count(row.onHand)} on hand`}
        action={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      />

      <div className="grid gap-4 px-3 py-3 lg:grid-cols-2">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            adjust.mutate();
          }}
        >
          <h3 className="text-[12px] font-semibold">Adjust stock</h3>
          <div className="flex gap-3">
            <Field label="Change (packs)" htmlFor="adjust-delta" className="w-36">
              <Input
                id="adjust-delta"
                required
                type="number"
                step={1}
                placeholder="-5"
                value={delta}
                onChange={(event) => setDelta(event.target.value)}
              />
            </Field>
            <Field label="Reason" htmlFor="adjust-reason" className="flex-1">
              <Input
                id="adjust-reason"
                required
                minLength={4}
                maxLength={200}
                placeholder="Damaged in transit — 5 packs discarded"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={adjust.isPending || !deltaIsUsable}>
            {adjust.isPending ? "Recording…" : "Record adjustment"}
          </Button>
          <p className="text-muted-foreground text-[11px]">
            {/*
              Both halves are the server's rules rather than this form's: `@NotEquals(0)` on the DTO
              and the conditional `UPDATE`'s `onHand + delta >= reserved`. Saying them here means the
              refusal is not the first time an operator hears about them.
            */}
            Signed: positive for a receipt, negative for shrinkage. Zero is refused — it would write
            a ledger row asserting a movement that never happened. A reason is required, and it is
            what the history will say. An adjustment that would take stock below the{" "}
            {count(row.reserved)} reserved for open orders is refused.
          </p>
        </form>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            saveThreshold.mutate();
          }}
        >
          <h3 className="text-[12px] font-semibold">Low-stock threshold</h3>
          <Field label="Warn at or below" htmlFor="threshold-value" className="w-36">
            <Input
              id="threshold-value"
              required
              type="number"
              min={0}
              step={1}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={saveThreshold.isPending || threshold.trim() === ""}
          >
            {saveThreshold.isPending ? "Saving…" : "Save threshold"}
          </Button>
          <p className="text-muted-foreground text-[11px]">
            This is where a threshold is changed — it can only be <em>set</em> when the pack is
            created. Changing it moves no stock, so it writes <strong>no ledger row</strong>; it
            writes an audit row instead. `0` is legal and means "warn me only when it is actually
            gone".
          </p>
        </form>
      </div>

      <div className="border-border border-t">
        <PanelHeader
          title="Stock history"
          hint={
            ledger.data === undefined
              ? "Loading…"
              : `${count(total)} ${total === 1 ? "movement" : "movements"}, newest first`
          }
        />
        {ledger.isPending ? (
          <Loading label="Loading the stock ledger" />
        ) : ledger.isError ? (
          <Notice
            tone="error"
            title="The stock history could not be loaded."
            body={errorMessage(ledger.error)}
            action={
              <Button variant="outline" onClick={() => void ledger.refetch()}>
                Try again
              </Button>
            }
          />
        ) : ledger.data.items.length === 0 ? (
          <Notice
            title="No stock has moved yet."
            body="Every receipt, sale, adjustment, return and cancellation appears here once it happens."
          />
        ) : (
          <TableWrap>
            <Table caption={`Stock movements for ${row.sku}`}>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Movement</Th>
                  <Th numeric>Change</Th>
                  <Th numeric>Balance</Th>
                  <Th>Reason</Th>
                  <Th>Admin</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.items.map((entry) => (
                  <Tr key={entry.id}>
                    <Td className="text-muted-foreground tnum whitespace-nowrap">
                      {dateTime(entry.createdAt)}
                    </Td>
                    <Td>{entry.type}</Td>
                    <Td numeric className={entry.delta < 0 ? "text-destructive" : "text-leaf"}>
                      {entry.delta > 0 ? `+${count(entry.delta)}` : count(entry.delta)}
                    </Td>
                    <Td numeric>{count(entry.balanceAfter)}</Td>
                    <Td className="max-w-72 truncate">
                      {entry.reason}
                      {entry.orderNumber !== null && (
                        <span className="text-muted-foreground tnum block text-[11px]">
                          {entry.orderNumber}
                        </span>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">
                      {/*
                        Null for a movement no admin made — a `SALE` is written by checkout on a
                        customer's behalf — and null again for a deleted admin, whose history
                        survives without an attribution. "System" is the honest word for both.
                      */}
                      {entry.actorName ?? "System"}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}

        {ledger.data !== undefined && ledger.data.items.length > 0 && lastPage > 1 && (
          <div className="flex items-center justify-between px-3 py-2">
            <p className="text-muted-foreground tnum text-[11px]">
              Page {count(ledgerPage)} of {count(lastPage)}
            </p>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={ledgerPage <= 1}
                onClick={() => setLedgerPage((current) => current - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={ledgerPage >= lastPage}
                onClick={() => setLedgerPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}

        <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
          This ledger is the audit trail for stock, and it is the only one:{" "}
          <strong>the admin audit log deliberately carries no stock movements</strong>. The audit
          log answers who changed a price, a threshold or a listing; this answers where the stock
          went.
        </p>
      </div>
    </Panel>
  );
}
