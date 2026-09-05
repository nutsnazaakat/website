import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Page } from "@/components/page";
import { ChannelBadge, PaymentBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import { fetchOrder } from "@/features/orders/api/orders";
import { PaymentWrite, ShipmentWrite, StatusWrite } from "@/features/orders/order-writes";
import { count, dateOnly, dateTime, inr, statusLabel } from "@/lib/format";

/**
 * `/orders/$orderNumber` — one order, and the three writes on it.
 *
 * **The parameter is named `$orderNumber`, not `$id`.** Spec §7.1 writes the route as
 * `/orders/$id`, and the path itself is identical either way, but `AdminOrder.id` *is* the order
 * number — `NN-2026-005107` — and every admin route is addressed by it, with no `ParseUUIDPipe`
 * anywhere near it. Naming the parameter `$id` invites the next reader to pass a uuid and get a
 * 404 they cannot explain.
 *
 * This file sits in `routes/_console/orders/` alongside `index.tsx`, with **no `orders.tsx`
 * beside the directory**. That is the trap the backend repo hit three times: a sibling file becomes
 * the layout route, and without an `<Outlet />` the child resolves successfully and renders
 * nothing at all.
 */
export const Route = createFileRoute("/_console/orders/$orderNumber")({
  component: OrderDetailScreen,
});

function OrderDetailScreen() {
  const { orderNumber } = Route.useParams();

  const order = useQuery({
    queryKey: ["order", orderNumber],
    queryFn: ({ signal }) => fetchOrder(orderNumber, signal),
  });

  if (order.isPending) {
    return (
      <Page title={orderNumber}>
        <Loading label="Loading the order" />
      </Page>
    );
  }

  if (order.isError) {
    return (
      <Page title={orderNumber}>
        <Panel>
          <Notice
            tone="error"
            title="This order could not be loaded."
            body={errorMessage(order.error)}
            action={
              <Link to="/orders" className="text-primary text-[12px] hover:underline">
                Back to orders
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const data = order.data;

  return (
    <Page
      title={data.id}
      description={`Placed ${dateTime(data.placedAt)} · estimated delivery ${dateOnly(data.estimatedDelivery)}`}
      actions={
        <>
          <ChannelBadge channel={data.channel} />
          <StatusBadge channel={data.channel} status={data.status} />
          <Link
            to="/orders"
            className="text-muted-foreground inline-flex items-center gap-1 text-[12px] hover:underline"
          >
            <ArrowLeft className="size-3.5" />
            Orders
          </Link>
        </>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Items" hint={`${count(data.items.length)} lines`} />
            <TableWrap>
              <Table caption={`Items on order ${data.id}`}>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Pack</Th>
                    <Th numeric>Qty</Th>
                    <Th numeric>Line total</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((line, index) => (
                    <Tr key={`${line.name}-${String(index)}`}>
                      <Td>{line.name}</Td>
                      <Td className="text-muted-foreground">{line.detail}</Td>
                      <Td numeric>{count(line.qty)}</Td>
                      <Td numeric>
                        {/*
                          `null` is a real value, not a missing one: a bulk line fulfilled against a
                          negotiated quote has no unit price on the order. Rendering it as ₹0 would
                          claim the goods were free.
                        */}
                        {line.total === null ? (
                          <span className="text-muted-foreground">Quoted</span>
                        ) : (
                          inr(line.total)
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <dl className="ml-auto grid w-64 grid-cols-2 gap-x-3 gap-y-1 px-3 py-3 text-[12px]">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="tnum text-right">{inr(data.subtotal)}</dd>
              <dt className="text-muted-foreground">
                Discount{data.couponCode === undefined ? "" : ` (${data.couponCode})`}
              </dt>
              <dd className="tnum text-right">−{inr(data.discount)}</dd>
              <dt className="text-muted-foreground">GST</dt>
              <dd className="tnum text-right">{inr(data.gst)}</dd>
              <dt className="text-muted-foreground">Shipping</dt>
              <dd className="tnum text-right">{inr(data.shipping)}</dd>
              <dt className="border-border mt-1 border-t pt-1 font-semibold">Total</dt>
              <dd className="border-border tnum mt-1 border-t pt-1 text-right font-semibold">
                {inr(data.total)}
              </dd>
            </dl>
          </Panel>

          <Panel>
            <PanelHeader title="Timeline" hint="Oldest first" />
            <ol className="flex flex-col gap-2 px-3 py-3">
              {data.timeline.map((event, index) => (
                <li key={`${event.status}-${event.at}-${String(index)}`} className="text-[12px]">
                  <span className="font-medium">{statusLabel(event.status)}</span>{" "}
                  <span className="text-muted-foreground tnum">{dateTime(event.at)}</span>
                  {event.note !== undefined && (
                    <p className="text-muted-foreground">{event.note}</p>
                  )}
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Customer" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-3 text-[12px]">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{data.customer.name}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{data.customer.email}</dd>
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="tnum">{data.customer.phone}</dd>
              <dt className="text-muted-foreground">Account</dt>
              <dd>
                {/*
                  `userId` is the field that says "guest" as opposed to "an account whose name
                  happens to match the delivery name" — the contract is explicit that the contact
                  details come from the order's own address snapshot, never from the account.
                */}
                {data.customer.userId === null ? "Guest checkout" : "Registered"}
              </dd>
              {data.customer.companyName !== null && (
                <>
                  <dt className="text-muted-foreground">Business</dt>
                  <dd>{data.customer.companyName}</dd>
                </>
              )}
              {data.gstin !== undefined && (
                <>
                  <dt className="text-muted-foreground">GSTIN</dt>
                  <dd className="tnum">{data.gstin}</dd>
                </>
              )}
              {data.poNumber !== undefined && (
                <>
                  <dt className="text-muted-foreground">PO number</dt>
                  <dd className="tnum">{data.poNumber}</dd>
                </>
              )}
            </dl>
          </Panel>

          <Panel>
            <PanelHeader title="Delivery address" />
            {/*
              One element per line rather than bare text nodes separated by `<br />`. It is better
              markup — each line is addressable — and it is what makes the route test able to assert
              on a single line of the address rather than on the whole block's concatenated text.
            */}
            <address className="flex flex-col px-3 py-3 text-[12px] not-italic">
              <span>{data.address.fullName}</span>
              <span>{data.address.line1}</span>
              {data.address.line2 !== undefined && data.address.line2 !== "" && (
                <span>{data.address.line2}</span>
              )}
              <span>
                {data.address.city}, {data.address.state}
              </span>
              <span className="tnum">{data.address.pincode}</span>
              <span className="tnum">{data.address.phone}</span>
            </address>
          </Panel>

          <div className="flex items-center gap-2 px-1">
            <PaymentBadge method={data.paymentMethod} status={data.paymentStatus} />
          </div>

          <StatusWrite order={data} />
          <PaymentWrite order={data} />
          <ShipmentWrite order={data} />

          <Button variant="ghost" onClick={() => void order.refetch()}>
            Reload this order
          </Button>
        </div>
      </div>
    </Page>
  );
}
