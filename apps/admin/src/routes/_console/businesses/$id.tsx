import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Lock } from "lucide-react";
import type { SavedAddress } from "@/contract";
import { Detail, DetailList } from "@/components/detail-list";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { fetchBusiness, SEGMENT_LABELS } from "@/features/businesses/api/businesses";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateOnly, inr } from "@/lib/format";

/**
 * `/businesses/$id` — brief §19's stored profile as the operator reads it, and brief §35's B2B
 * figures.
 *
 * **`PATCH /admin/businesses/:id` does not exist.** Backend design spec §6.4 lists it; nothing
 * implements it, and plan 9.3 recorded the gap. So the two fields an operator would most want to
 * change here — brief §31's price band (`segment`) and the assigned salesperson — are shown as
 * facts with a padlock and an explanation, not as inputs.
 *
 * That is the whole point of building the screen this way. An input that cannot save is worse than
 * no input: the operator types a value, presses a button, gets a 404, and now believes the console
 * is broken rather than knowing the endpoint was never built. Saying so in one sentence turns an
 * unexplainable failure into a known limitation somebody can schedule.
 */
export const Route = createFileRoute("/_console/businesses/$id")({
  component: BusinessDetailScreen,
});

function BusinessDetailScreen() {
  const { id } = Route.useParams();

  const business = useQuery({
    queryKey: ["business", id],
    queryFn: ({ signal }) => fetchBusiness(id, signal),
  });

  if (business.isPending) {
    return (
      <Page title="Business">
        <Loading label="Loading the business" />
      </Page>
    );
  }

  if (business.isError) {
    return (
      <Page title="Business">
        <Panel>
          <Notice
            tone="error"
            title="This business could not be loaded."
            body={errorMessage(business.error)}
            action={
              <Link to="/businesses" className="text-primary text-[12px] hover:underline">
                Back to businesses
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const record = business.data;

  return (
    <Page
      title={record.companyName}
      description={record.businessType}
      actions={
        <Link to="/businesses">
          <Button variant="outline" size="sm">
            <ArrowLeft />
            All businesses
          </Button>
        </Link>
      }
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Profile" />
          <DetailList>
            <Detail label="Company">{record.companyName}</Detail>
            <Detail label="Contact">{record.contactPerson}</Detail>
            <Detail label="Mobile">
              <span className="tnum">
                {record.mobile === "" ? "Not filled in yet" : record.mobile}
              </span>
            </Detail>
            <Detail
              label="Account email"
              hint="A business has no email of its own; this is the account's."
            >
              {record.email}
            </Detail>
            <Detail label="GSTIN">
              <span className="tnum">{record.gstin ?? "Not provided"}</span>
            </Detail>
            <Detail label="Business type">{record.businessType}</Detail>
            <Detail label="Registered">
              <span className="tnum">{dateOnly(record.createdAt)}</span>
            </Detail>
          </DetailList>
          <div className="border-border border-t px-3 py-2">
            <Link
              to="/customers/$id"
              params={{ id: record.userId }}
              className="text-primary text-[12px] hover:underline"
            >
              Open the account behind this business
            </Link>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Trading" />
          <DetailList>
            <Detail
              label="Orders"
              hint="Every order on this account, retail and bulk, whatever its status."
            >
              <span className="tnum">{count(record.orders)}</span>
            </Detail>
            <Detail
              label="Total spend"
              hint="Excludes cancelled and refunded orders, and covers both channels — the same figure the customer screen reports for this account."
            >
              <span className="tnum font-medium">{inr(record.totalSpend)}</span>
            </Detail>
            <Detail label="Last order">
              <span className="tnum">
                {record.lastOrderAt === null ? "None yet" : dateOnly(record.lastOrderAt)}
              </span>
            </Detail>
            <Detail
              label="Quote requests"
              hint="Open out of every enquiry this account has raised."
            >
              <span className="tnum">
                {count(record.openRfqs)} open of {count(record.rfqs)}
              </span>
            </Detail>
          </DetailList>
          <div className="border-border border-t px-3 py-2">
            <Link
              to="/rfqs"
              search={{ q: record.companyName }}
              className="text-primary text-[12px] hover:underline"
            >
              Find this company&rsquo;s enquiries
            </Link>
          </div>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader
            title="Commercial"
            hint="Read-only"
            action={
              <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                <Lock className="size-3" />
                No endpoint
              </span>
            }
          />
          <DetailList>
            <Detail label="Price band">
              <span className="font-medium">{SEGMENT_LABELS[record.segment]}</span>
            </Detail>
            <Detail label="Assigned salesperson">
              {record.assignedSalesperson === null ? (
                "Unassigned"
              ) : (
                <>
                  {record.assignedSalesperson.name}{" "}
                  <span className="text-muted-foreground">
                    ({record.assignedSalesperson.email})
                  </span>
                </>
              )}
            </Detail>
          </DetailList>
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            Both of these are set in the database and cannot be changed from this console:{" "}
            <code>PATCH /admin/businesses/:id</code> is listed in the backend design spec §6.4 but
            was never built. No input is offered rather than one that would answer 404. The band
            decides which brief §31 pricing ladder this customer resolves, so it is a commercial
            decision worth a real screen when the endpoint exists. A salesperson <em>can</em> be
            assigned on an individual quote request.
          </p>
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="Addresses" hint="From the customer's own address book" />
          <div className="grid gap-2 px-3 py-3 sm:grid-cols-2">
            <AddressBlock title="Billing" address={record.billingAddress} />
            <AddressBlock title="Shipping" address={record.shippingAddress} />
          </div>
          <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
            A reference to an address the customer has since deleted reads back as not set, rather
            than as the deleted row — the operator and the business see the same answer.
          </p>
        </Panel>
      </div>
    </Page>
  );
}

function AddressBlock({ title, address }: { title: string; address: SavedAddress | null }) {
  return (
    <div className="border-border rounded border px-2 py-1.5 text-[12px]">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </p>
      {address === null ? (
        <p className="text-muted-foreground">Not set</p>
      ) : (
        <>
          <p className="font-medium">{address.fullName}</p>
          <p className="text-muted-foreground">
            {address.line1}
            {address.line2 === undefined || address.line2 === "" ? "" : `, ${address.line2}`}
          </p>
          <p className="text-muted-foreground tnum">
            {address.city}, {address.state} {address.pincode}
          </p>
          <p className="text-muted-foreground tnum">{address.phone}</p>
        </>
      )}
    </div>
  );
}
