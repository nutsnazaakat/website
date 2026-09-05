import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { SavedAddress } from "@/contract";
import { Detail, DetailList } from "@/components/detail-list";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { fetchCustomer } from "@/features/customers/api/customers";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateOnly, dateTime, inr } from "@/lib/format";

/**
 * `/customers/$id` — one account in full. Brief §35.
 *
 * `$id` and not `$customerNumber`: unlike an order or an enquiry, a customer has no human-readable
 * reference, and `AdminCustomersController` puts a `ParseUUIDPipe` on the parameter. Anything else
 * is a 400 before the service is reached, which is why the not-found notice below says so.
 *
 * **Nothing on this screen is editable, and no control pretends otherwise.** §6.4 exposes no
 * `PATCH /admin/customers/:id`: an account's name, email and phone are the customer's to change
 * through `PATCH /account/profile`, and `isActive` has no write path anywhere in the service yet.
 * The one commercially-meaningful field an operator might want — the B2B price band — is on the
 * business record, and is not editable there either. `/businesses/$id` explains why.
 */
export const Route = createFileRoute("/_console/customers/$id")({
  component: CustomerDetailScreen,
});

function CustomerDetailScreen() {
  const { id } = Route.useParams();

  const customer = useQuery({
    queryKey: ["customer", id],
    queryFn: ({ signal }) => fetchCustomer(id, signal),
  });

  if (customer.isPending) {
    return (
      <Page title="Customer">
        <Loading label="Loading the customer" />
      </Page>
    );
  }

  if (customer.isError) {
    return (
      <Page title="Customer">
        <Panel>
          <Notice
            tone="error"
            title="This customer could not be loaded."
            body={errorMessage(customer.error)}
            action={
              <Link to="/customers" className="text-primary text-[12px] hover:underline">
                Back to customers
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const record = customer.data;
  const business = record.business;

  return (
    <Page
      title={record.name}
      description={record.role === "b2b" ? "B2B account" : "B2C account"}
      actions={
        <Link to="/customers">
          <Button variant="outline" size="sm">
            <ArrowLeft />
            All customers
          </Button>
        </Link>
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Account" hint={record.isActive ? "Active" : "Deactivated"} />
          <DetailList>
            <Detail label="Name">{record.name}</Detail>
            <Detail label="Email">{record.email}</Detail>
            <Detail label="Phone">
              <span className="tnum">{record.phone}</span>
            </Detail>
            <Detail label="Type">
              {record.role === "b2b" ? "B2B (business)" : "B2C (retail)"}
            </Detail>
            <Detail label="Registered">
              <span className="tnum">{dateOnly(record.createdAt)}</span>
            </Detail>
            <Detail label="Last signed in">
              <span className="tnum">
                {record.lastLoginAt === null ? "Never" : dateTime(record.lastLoginAt)}
              </span>
            </Detail>
          </DetailList>
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            The customer maintains these themselves; there is no admin write path for an account.
          </p>
        </Panel>

        <Panel>
          <PanelHeader title="Trading" />
          <DetailList>
            <Detail label="Orders" hint="Every order, whatever its status.">
              <span className="tnum">{count(record.orders)}</span>
            </Detail>
            <Detail
              label="Total spend"
              hint="Excludes cancelled and refunded orders — the same figure the dashboard and the customer's own account page report. It will not reconcile against the order count."
            >
              <span className="tnum font-medium">{inr(record.totalSpend)}</span>
            </Detail>
            <Detail label="Last order">
              <span className="tnum">
                {record.lastOrderAt === null ? "None yet" : dateOnly(record.lastOrderAt)}
              </span>
            </Detail>
          </DetailList>
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            The order list cannot yet be filtered to one customer — `GET /admin/orders` takes no
            customer parameter.
          </p>
        </Panel>

        {business !== null && (
          <Panel className="lg:col-span-2">
            <PanelHeader title="Business" hint={business.companyName} />
            <DetailList>
              <Detail label="Company">{business.companyName}</Detail>
              <Detail label="Business type">{business.businessType}</Detail>
              <Detail label="GSTIN">
                <span className="tnum">{business.gstin ?? "Not provided"}</span>
              </Detail>
              <Detail
                label="Price band"
                hint="Brief §31's segment. Read-only — there is no endpoint that changes it."
              >
                <span className="capitalize">{business.segment}</span>
              </Detail>
            </DetailList>
            <div className="border-border border-t px-3 py-2">
              <Link
                to="/businesses/$id"
                params={{ id: business.id }}
                className="text-primary text-[12px] hover:underline"
              >
                Open the full business profile
              </Link>
            </div>
          </Panel>
        )}

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Address book"
            hint={
              record.addresses.length === 0
                ? "None saved"
                : `${String(record.addresses.length)} saved`
            }
          />
          {record.addresses.length === 0 ? (
            <p className="text-muted-foreground px-3 py-3 text-[12px]">
              This account has saved no addresses. A guest checkout does not create one.
            </p>
          ) : (
            <ul className="grid gap-2 px-3 py-3 sm:grid-cols-2">
              {record.addresses.map((address) => (
                <AddressCard key={address.id} address={address} />
              ))}
            </ul>
          )}
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            An address the customer has deleted is absent here, not struck through — the operator
            sees the book the customer sees.
          </p>
        </Panel>
      </div>
    </Page>
  );
}

function AddressCard({ address }: { address: SavedAddress }) {
  return (
    <li className="border-border rounded border px-2 py-1.5 text-[12px]">
      <p className="flex items-baseline gap-2 font-medium">
        {address.label}
        {address.isDefault && (
          <span className="border-border text-muted-foreground rounded border px-1 text-[9px] tracking-wide uppercase">
            Default
          </span>
        )}
      </p>
      <p>{address.fullName}</p>
      <p className="text-muted-foreground">
        {address.line1}
        {address.line2 === undefined || address.line2 === "" ? "" : `, ${address.line2}`}
      </p>
      <p className="text-muted-foreground tnum">
        {address.city}, {address.state} {address.pincode}
      </p>
      <p className="text-muted-foreground tnum">{address.phone}</p>
    </li>
  );
}
