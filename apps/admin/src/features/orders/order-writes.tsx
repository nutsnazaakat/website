import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { type AdminOrder, type OrderStatus, nextStatuses } from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import {
  allowedTransitionsFrom,
  errorMessage,
  isConcurrentModification,
} from "@/features/orders/api/errors";
import { changeOrderStatus, collectPayment, createShipment } from "@/features/orders/api/orders";
import { dateTime, statusLabel } from "@/lib/format";

/**
 * The three writes on an order: a status transition, a COD collection, and a shipment.
 *
 * All three answer **200 with the whole re-read `AdminOrder`**, so each one replaces the detail
 * query's cache from its own result rather than refetching — the operator sees the new timeline
 * without a second round trip, and cannot be shown a stale order for the moment in between.
 */

function useOrderWrite(orderNumber: string) {
  const client = useQueryClient();
  return (order: AdminOrder) => {
    client.setQueryData(["order", orderNumber], order);
    // The list's `total` and every row's status may have moved, and the dashboard's cards
    // certainly have. Invalidating rather than patching: this screen does not know which of the
    // list's cached filter combinations this order belongs to.
    void client.invalidateQueries({ queryKey: ["orders"] });
    void client.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

/**
 * The status transition.
 *
 * The buttons come from `nextStatuses` in the contract — the same table the server validates
 * against — so an illegal move is not normally offerable. That is UX, not enforcement: the server
 * is still the authority, and when it refuses, **`allowed` from the 422 replaces the buttons**.
 * That case is real rather than theoretical: another operator moving the order first leaves this
 * screen's idea of `status` stale, and the server's answer is the only current one.
 *
 * A **409** is different and handled differently. It carries the same `code` at a different status
 * and no `allowed`, because the order is no longer in the state this screen reasoned about. Nothing
 * derived from a stale read is trustworthy then, so the order is refetched rather than re-offered.
 */
export function StatusWrite({ order }: { order: AdminOrder }) {
  const apply = useOrderWrite(order.id);
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const [serverAllowed, setServerAllowed] = useState<OrderStatus[] | null>(null);
  /**
   * Declared above the mutation that closes over it. `restock` is required if and only if the
   * target status is `refunded`, and it is a real choice rather than a default: `true` returns
   * the goods to sellable stock, `false` writes them off, and only the operator knows which
   * happened to the parcel.
   */
  const [restock, setRestock] = useState(true);

  const mutation = useMutation({
    mutationFn: (status: OrderStatus) =>
      changeOrderStatus(order.id, {
        status,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        // Sent if and only if the target is `refunded` — `@ValidateIf` on the DTO. Sending it
        // otherwise fails `whitelist`; omitting it on a refund fails validation.
        ...(status === "refunded" ? { restock } : {}),
      }),
    onSuccess: (updated) => {
      setServerAllowed(null);
      setNote("");
      apply(updated);
      toast.success(`Order is now ${statusLabel(updated.status)}.`);
    },
    onError: (error: unknown) => {
      const allowed = allowedTransitionsFrom(error);
      if (allowed !== null) {
        // The server has already worked out the real choices. Render them rather than "failed".
        setServerAllowed(allowed);
        toast.error(errorMessage(error));
        return;
      }
      if (isConcurrentModification(error)) {
        void client.invalidateQueries({ queryKey: ["order", order.id] });
        toast.error("Somebody else moved this order. It has been reloaded.");
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const local = nextStatuses(order.channel, order.status);
  const options = serverAllowed ?? local;

  return (
    <Panel>
      <PanelHeader title="Status" hint={statusLabel(order.status)} />
      <div className="flex flex-col gap-3 px-3 py-3">
        {options.length === 0 ? (
          <p className="text-muted-foreground text-[12px]">
            {serverAllowed === null
              ? `A ${order.channel === "bulk" ? "bulk" : "retail"} order that is ${statusLabel(order.status)} is finished — there is nowhere further for it to go.`
              : "The server reports no legal transitions from here."}
          </p>
        ) : (
          <>
            {serverAllowed !== null && (
              <p role="status" className="text-muted-foreground text-[12px]">
                The server refused that move. From {statusLabel(order.status)} it allows only what
                is shown below.
              </p>
            )}
            <Field label="Note (optional)" htmlFor="status-note">
              <Input
                id="status-note"
                maxLength={300}
                placeholder="Appears on the customer's timeline"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>

            {options.includes("refunded") && (
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={restock}
                  onChange={(event) => setRestock(event.target.checked)}
                />
                Return the goods to sellable stock when refunding
              </label>
            )}

            <div className="flex flex-wrap gap-1.5">
              {options.map((status) => (
                <Button
                  key={status}
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate(status)}
                >
                  {mutation.isPending && mutation.variables === status
                    ? "Saving…"
                    : `Mark ${statusLabel(status)}`}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * COD collection.
 *
 * **The control disappears once `paymentStatus` is `collected`.** The endpoint is idempotent
 * server-side — the second call writes nothing, not even an audit row, and a different `reference`
 * on the retry is ignored rather than applied — so a second click would report success while having
 * changed nothing. Showing what was actually recorded is the honest alternative to a button that
 * lies.
 *
 * Only for `cod`. An `online` order answers 422 `PAYMENT_METHOD_UNAVAILABLE`, so there is no reason
 * to offer it.
 */
export function PaymentWrite({ order }: { order: AdminOrder }) {
  const apply = useOrderWrite(order.id);
  const [reference, setReference] = useState("");

  const mutation = useMutation({
    mutationFn: () => collectPayment(order.id, reference.trim()),
    onSuccess: (updated) => {
      setReference("");
      apply(updated);
      toast.success(
        updated.paymentReference === null
          ? "Recorded as collected."
          : `Recorded as collected against ${updated.paymentReference}.`,
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  if (order.paymentMethod !== "cod") {
    return (
      <Panel>
        <PanelHeader title="Payment" hint={order.paymentMethod.toUpperCase()} />
        <p className="text-muted-foreground px-3 py-3 text-[12px]">
          Only cash on delivery is collected from this console.
        </p>
      </Panel>
    );
  }

  if (order.paymentStatus === "collected") {
    return (
      <Panel>
        <PanelHeader title="Payment" hint="COD collected" />
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-3 text-[12px]">
          <dt className="text-muted-foreground">Collected</dt>
          <dd className="tnum">
            {order.paymentCollectedAt === null ? "—" : dateTime(order.paymentCollectedAt)}
          </dd>
          <dt className="text-muted-foreground">Receipt</dt>
          <dd className="tnum">{order.paymentReference ?? "None recorded"}</dd>
        </dl>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader title="Payment" hint="COD outstanding" />
      <form
        className="flex flex-col gap-3 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <Field label="Receipt number (optional)" htmlFor="payment-reference">
          <Input
            id="payment-reference"
            maxLength={120}
            placeholder="A delivery agent may hand over cash without one"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Recording…" : "Record COD collected"}
        </Button>
        <p className="text-muted-foreground text-[11px]">
          The amount comes from the order — it cannot be edited here.
        </p>
      </form>
    </Panel>
  );
}

/**
 * The shipment.
 *
 * **Creating one also moves the order to `shipped`**, in the same transaction and with the
 * transition attempted first — so an order that cannot legally reach `shipped` is refused with the
 * same 422 and no shipment row is written. The consequence, stated on the DTO itself, is that this
 * route cannot record a second dispatch or attach a late AWB: `shipped -> shipped` is refused and
 * there is no `PATCH /admin/shipments/:id`. The form says so rather than offering a control that
 * can only fail.
 */
export function ShipmentWrite({ order }: { order: AdminOrder }) {
  const apply = useOrderWrite(order.id);
  const [courier, setCourier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      createShipment(order.id, { courier: courier.trim(), trackingNumber: trackingNumber.trim() }),
    onSuccess: (updated) => {
      setCourier("");
      setTrackingNumber("");
      apply(updated);
      toast.success("Dispatch recorded. The order is now Shipped.");
    },
    onError: (error: unknown) => {
      const allowed = allowedTransitionsFrom(error);
      toast.error(
        allowed === null
          ? errorMessage(error)
          : allowed.length === 0
            ? `${errorMessage(error)} This order is finished; nothing was recorded.`
            : `${errorMessage(error)} From here it can only become ${allowed.map(statusLabel).join(" or ")}. Nothing was recorded.`,
      );
    },
  });

  const canShip = nextStatuses(order.channel, order.status).includes("shipped");

  return (
    <Panel>
      <PanelHeader
        title="Shipment"
        hint={
          order.shipments.length === 0
            ? "None recorded"
            : `${String(order.shipments.length)} recorded`
        }
      />
      <div className="flex flex-col gap-3 px-3 py-3">
        {order.shipments.length > 0 && (
          <ul className="flex flex-col gap-2">
            {order.shipments.map((shipment) => (
              <li
                key={shipment.id}
                className="border-border rounded border px-2 py-1.5 text-[12px]"
              >
                <p className="font-medium">{shipment.courier}</p>
                <p className="text-muted-foreground tnum">
                  {shipment.trackingNumber ?? "No tracking number"} · {shipment.status}
                </p>
              </li>
            ))}
          </ul>
        )}

        {order.shipments.length > 0 ? (
          <p className="text-muted-foreground text-[11px]">
            A second dispatch cannot be recorded, and a tracking number cannot be added afterwards —
            the endpoint also moves the order to Shipped, and it is already there. There is no route
            to amend a shipment.
          </p>
        ) : !canShip ? (
          <p className="text-muted-foreground text-[12px]">
            Recording a dispatch also moves the order to Shipped, which is not a legal move from{" "}
            {statusLabel(order.status)}. Advance the status first.
          </p>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <Field label="Courier" htmlFor="shipment-courier">
              <Input
                id="shipment-courier"
                required
                maxLength={80}
                value={courier}
                onChange={(event) => setCourier(event.target.value)}
              />
            </Field>
            <Field label="Tracking number (optional)" htmlFor="shipment-tracking">
              <Input
                id="shipment-tracking"
                maxLength={120}
                placeholder="An AWB sometimes follows the parcel"
                value={trackingNumber}
                onChange={(event) => setTrackingNumber(event.target.value)}
              />
            </Field>
            <Button type="submit" disabled={mutation.isPending || courier.trim() === ""}>
              {mutation.isPending ? "Recording…" : "Record dispatch"}
            </Button>
            <p className="text-muted-foreground text-[11px]">
              This also moves the order to Shipped.
            </p>
          </form>
        )}
      </div>
    </Panel>
  );
}
