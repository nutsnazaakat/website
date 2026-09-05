import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Detail, DetailList } from "@/components/detail-list";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Loading, Notice, Panel, PanelHeader } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { errorMessage } from "@/features/orders/api/errors";
import { fetchRfq } from "@/features/rfqs/api/rfqs";
import { RfqKindBadge, RfqStatusBadge } from "@/features/rfqs/rfq-status-badge";
import { RfqCommercialWrite, RfqNoteWrite, RfqStatusWrite } from "@/features/rfqs/rfq-writes";
import { count, dateOnly, dateTime, inr } from "@/lib/format";

/**
 * `/rfqs/$rfqNumber` — one enquiry in full, and the three writes on it.
 *
 * **The parameter is `$rfqNumber`, not `$id`.** Spec §7.1 writes the route as `/rfqs/$id`, and
 * `AdminRfq.id` *is* the RFQ number — `RFQ-2026-000123` — with no `ParseUUIDPipe` anywhere near
 * the controller. Naming it `$id` invites the next reader to pass a uuid and get a 404 they cannot
 * explain. `orders/$orderNumber` made the same correction for the same reason.
 *
 * This file sits in `routes/_console/rfqs/` beside `index.tsx`, with **no `rfqs.tsx` next to the
 * directory** — a sibling file becomes the layout route, and without an `<Outlet />` this child
 * would resolve successfully and paint nothing at all.
 *
 * **Two kinds of note appear on this screen and they are labelled apart, deliberately.** The
 * prospect's own "additional requirements" is their text, shown back to them on their enquiry page;
 * the internal notes are the sales trail and are staff-only. Writing one into the other would be a
 * privacy failure, so nothing on this screen can: there is no admin route that edits the customer's
 * field, and the note form says "internal" three times over.
 */
export const Route = createFileRoute("/_console/rfqs/$rfqNumber")({
  component: RfqDetailScreen,
});

function RfqDetailScreen() {
  const { rfqNumber } = Route.useParams();

  const rfq = useQuery({
    queryKey: ["rfq", rfqNumber],
    queryFn: ({ signal }) => fetchRfq(rfqNumber, signal),
  });

  if (rfq.isPending) {
    return (
      <Page title={rfqNumber}>
        <Loading label="Loading the enquiry" />
      </Page>
    );
  }

  if (rfq.isError) {
    return (
      <Page title={rfqNumber}>
        <Panel>
          <Notice
            tone="error"
            title="This enquiry could not be loaded."
            body={errorMessage(rfq.error)}
            action={
              <Link to="/rfqs" className="text-primary text-[12px] hover:underline">
                Back to quote requests
              </Link>
            }
          />
        </Panel>
      </Page>
    );
  }

  const record = rfq.data;
  const gifting = record.gifting;

  return (
    <Page
      title={record.id}
      description={`${record.businessName} · raised ${dateOnly(record.createdAt)}`}
      actions={
        <>
          <RfqStatusBadge status={record.status} />
          <RfqKindBadge kind={record.kind} />
          <Link to="/rfqs">
            <Button variant="outline" size="sm">
              <ArrowLeft />
              All enquiries
            </Button>
          </Link>
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="flex flex-col gap-3 lg:col-span-2">
          <Panel>
            <PanelHeader title="Enquiry" hint={record.businessName} />
            <DetailList>
              <Detail label="Company">{record.businessName}</Detail>
              <Detail label="Contact">{record.contactPerson}</Detail>
              <Detail label="Mobile">
                <span className="tnum">{record.mobile}</span>
              </Detail>
              <Detail label="Email">{record.email}</Detail>
              <Detail label="GSTIN">
                <span className="tnum">{record.gstin ?? "Not provided"}</span>
              </Detail>
              <Detail label="Business type">{record.businessType}</Detail>
              <Detail label="Pincode">
                <span className="tnum">{record.pincode}</span>
              </Detail>
              <Detail label="Packaging">{record.packaging ?? "—"}</Detail>
              <Detail label="Frequency">{record.frequency ?? "—"}</Detail>
              <Detail label="Account">
                {record.userId === null ? (
                  <span className="text-muted-foreground">
                    Raised without an account — the enquiry form is public.
                  </span>
                ) : (
                  <Link
                    to="/customers/$id"
                    params={{ id: record.userId }}
                    className="text-primary hover:underline"
                  >
                    Open the account
                  </Link>
                )}
              </Detail>
              <Detail label="Last updated">
                <span className="tnum">{dateTime(record.updatedAt)}</span>
              </Detail>
            </DetailList>
          </Panel>

          {record.kind === "gifting" && gifting !== null ? (
            <Panel>
              <PanelHeader title="Gifting brief" hint="Brief §24" />
              <DetailList>
                <Detail label="Occasion">{gifting.occasion}</Detail>
                <Detail label="Gift box">
                  <span className="tnum">{gifting.giftBoxSlug}</span>
                </Detail>
                <Detail label="Boxes">
                  <span className="tnum">{count(gifting.boxes)}</span>
                </Detail>
                <Detail label="Budget per box">
                  <span className="tnum">{inr(gifting.budgetPerBox)}</span>
                </Detail>
                <Detail label="Branding">
                  {gifting.brandingRequired ? "Required" : "Not required"}
                </Detail>
                <Detail label="Delivery date">
                  <span className="tnum">{gifting.deliveryDate}</span>
                </Detail>
                <Detail label="Message">
                  <span className="whitespace-pre-wrap">
                    {gifting.message === "" ? "—" : gifting.message}
                  </span>
                </Detail>
              </DetailList>
              <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
                A gifting enquiry has no product lines and no packaging question — the gift box is
                the packaging, and its quantity is a number of boxes rather than kilos.
              </p>
            </Panel>
          ) : (
            <Panel>
              <PanelHeader
                title="Products"
                hint={`${count(record.totalKg)} kg across ${String(record.lines.length)} ${record.lines.length === 1 ? "line" : "lines"}`}
              />
              {record.lines.length === 0 ? (
                <p className="text-muted-foreground px-3 py-3 text-[12px]">
                  No lines were submitted with this enquiry.
                </p>
              ) : (
                <TableWrap>
                  <Table caption="Products on this enquiry">
                    <thead>
                      <tr>
                        <Th>Product</Th>
                        <Th numeric>Quantity</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {record.lines.map((line) => (
                        <Tr key={line.productSlug}>
                          <Td className="tnum">{line.productSlug}</Td>
                          <Td numeric>{count(line.kg)} kg</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </Panel>
          )}

          <Panel>
            <PanelHeader title="What the customer wrote" hint="Visible to them" />
            <div className="px-3 py-3">
              {record.notes === null || record.notes.trim() === "" ? (
                <p className="text-muted-foreground text-[12px]">
                  Nothing was typed into the &ldquo;additional requirements&rdquo; box.
                </p>
              ) : (
                <p className="text-[12px] whitespace-pre-wrap">{record.notes}</p>
              )}
            </div>
            <p className="text-muted-foreground border-border border-t px-3 py-2 text-[11px]">
              This is the prospect&rsquo;s own text from the public enquiry form, and it is rendered
              back to them on their enquiry page. It is <strong className="font-medium">not</strong>{" "}
              the sales trail and cannot be edited from here — internal notes are a separate field,
              in the panel alongside.
            </p>
          </Panel>
        </div>

        <div className="flex flex-col gap-3">
          <RfqStatusWrite rfq={record} />
          <RfqCommercialWrite rfq={record} />
          <RfqNoteWrite rfq={record} />
        </div>
      </div>
    </Page>
  );
}
