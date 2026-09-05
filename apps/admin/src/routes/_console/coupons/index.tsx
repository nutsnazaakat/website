import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { AdminCoupon } from "@/contract";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Loading, Notice, Panel } from "@/components/ui/panel";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  COUPONS_PAGE_SIZE,
  deleteCoupon,
  fetchCoupons,
  redemptionsBlocking,
  updateCoupon,
} from "@/features/coupons/api/coupons";
import { CouponForm } from "@/features/coupons/coupon-form";
import { CouponStateBadge } from "@/features/coupons/coupon-badge";
import { discountLabel } from "@/features/coupons/coupon-state";
import { errorMessage } from "@/features/orders/api/errors";
import { count, dateTime, inr } from "@/lib/format";

/**
 * `/coupons` — brief §36, CRUD with both refusals rendered rather than swallowed.
 *
 * **Editing works from the loaded page, because there is no single-coupon read.** The controller
 * exposes `GET`, `POST /admin/coupons`, `PATCH` and `DELETE /admin/coupons/:code` — and no
 * `GET /admin/coupons/:code`. So `?edit=CODE` resolves against the rows this page already has, and
 * says so plainly when the code names a coupon on another page rather than firing a request that
 * would 404. That is a real §6.4 gap, not a design choice: it is the reason this screen is a list
 * with an inline editor instead of a list and a detail route.
 */

interface CouponsSearch {
  isActive?: boolean;
  edit?: string;
  page?: number;
}

export const Route = createFileRoute("/_console/coupons/")({
  validateSearch: (search: Record<string, unknown>): CouponsSearch => {
    const raw = search["isActive"];
    // The DTO's `toQueryBoolean` accepts exactly `"true"` and `"false"`; anything else reaches
    // `@IsBoolean()` unchanged and is a 400. Narrowed here so a hand-edited URL cannot produce one.
    const isActive =
      raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    const edit = search["edit"];
    const page = Number(search["page"]);

    return {
      ...(isActive === undefined ? {} : { isActive }),
      ...(typeof edit === "string" && edit.trim() !== ""
        ? { edit: edit.trim().toUpperCase() }
        : {}),
      ...(Number.isInteger(page) && page > 1 ? { page } : {}),
    };
  },
  component: CouponsScreen,
});

function CouponsScreen() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = search.page ?? 1;
  const [creating, setCreating] = useState(false);

  const coupons = useQuery({
    queryKey: ["coupons", { isActive: search.isActive, page }],
    queryFn: ({ signal }) =>
      fetchCoupons(
        {
          ...(search.isActive === undefined ? {} : { isActive: search.isActive }),
          page,
          limit: COUPONS_PAGE_SIZE,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  function setSearchParams(patch: Partial<CouponsSearch>, resetPage = true) {
    void navigate({
      search: (previous: CouponsSearch): CouponsSearch => {
        const next: CouponsSearch = { ...previous, ...patch };
        if (resetPage) delete next.page;
        if (next.isActive === undefined) delete next.isActive;
        if (next.edit === undefined || next.edit === "") delete next.edit;
        return next;
      },
    });
  }

  function goToPage(next: number) {
    void navigate({
      search: (previous: CouponsSearch): CouponsSearch => {
        const updated: CouponsSearch = { ...previous };
        if (next <= 1) delete updated.page;
        else updated.page = next;
        return updated;
      },
    });
  }

  const rows = coupons.data?.items ?? [];
  const editing =
    search.edit === undefined ? null : (rows.find((row) => row.code === search.edit) ?? null);
  const editMissing = search.edit !== undefined && editing === null && coupons.data !== undefined;
  const total = coupons.data?.total ?? 0;

  return (
    <Page
      title="Coupons"
      description={
        coupons.data === undefined
          ? "Loading…"
          : `${count(total)} ${total === 1 ? "coupon" : "coupons"}`
      }
      actions={
        <Button
          onClick={() => {
            setCreating(true);
            setSearchParams({ edit: undefined }, false);
          }}
        >
          New coupon
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {creating && (
          <CouponForm
            coupon={null}
            onDone={() => {
              setCreating(false);
            }}
          />
        )}

        {editing !== null && (
          <CouponForm
            // Keyed by code, so opening a different coupon rebuilds the form from that row rather
            // than leaving the previous coupon's values in the boxes.
            key={editing.code}
            coupon={editing}
            onDone={() => setSearchParams({ edit: undefined }, false)}
          />
        )}

        {editMissing && (
          <Panel>
            <Notice
              title={`${String(search.edit)} is not on this page.`}
              body="There is no endpoint that reads a single coupon, so the editor works from the rows already loaded. Clear the filter, or page to the one you want."
              action={
                <Button
                  variant="outline"
                  onClick={() => setSearchParams({ edit: undefined }, false)}
                >
                  Close the editor
                </Button>
              }
            />
          </Panel>
        )}

        <Panel className="flex flex-wrap items-end gap-3 px-3 py-2.5">
          <Field label="Switched on" htmlFor="filter-active" className="w-40">
            <Select
              id="filter-active"
              value={search.isActive === undefined ? "" : String(search.isActive)}
              onChange={(event) =>
                setSearchParams({
                  isActive:
                    event.target.value === "true"
                      ? true
                      : event.target.value === "false"
                        ? false
                        : undefined,
                })
              }
            >
              <option value="">All coupons</option>
              <option value="true">Active only</option>
              <option value="false">Switched off only</option>
            </Select>
          </Field>
          <p className="text-muted-foreground mb-1.5 ml-auto max-w-lg text-right text-[11px]">
            &ldquo;Active&rdquo; is the switch, not the state: a coupon can be switched on and still
            be expired, not yet started, or out of redemptions. The status column says which.
          </p>
        </Panel>

        <Panel>
          {coupons.isPending ? (
            <Loading label="Loading coupons" />
          ) : coupons.isError ? (
            <Notice
              tone="error"
              title="Coupons could not be loaded."
              body={errorMessage(coupons.error)}
              action={
                <Button variant="outline" onClick={() => void coupons.refetch()}>
                  Try again
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <Notice
              title="No coupons."
              body="Create one to start a campaign. A coupon's code is what an order snapshots, so pick it carefully — it cannot be changed later."
            />
          ) : (
            <TableWrap>
              <Table caption="Coupons, newest first">
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Discount</Th>
                    <Th>Conditions</Th>
                    <Th numeric>Redeemed</Th>
                    <Th>Window</Th>
                    <Th>Status</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((coupon) => (
                    <CouponRow
                      key={coupon.code}
                      coupon={coupon}
                      onEdit={() => {
                        setCreating(false);
                        setSearchParams({ edit: coupon.code }, false);
                      }}
                    />
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}

          {coupons.data !== undefined && rows.length > 0 && (
            <Pager
              page={page}
              total={total}
              pageSize={COUPONS_PAGE_SIZE}
              onPage={goToPage}
              unit="coupon"
            />
          )}
        </Panel>
      </div>
    </Page>
  );
}

/**
 * One row, with the two writes it offers: switch off, and delete.
 *
 * **Switching off is offered first and delete second, because switching off is almost always the
 * operation an operator actually wants.** A deleted coupon cannot be brought back and its
 * configuration is gone; a switched-off one stops working immediately, keeps its redemption
 * history, and can be switched back on for next Diwali.
 */
function CouponRow({ coupon, onEdit }: { coupon: AdminCoupon; onEdit: () => void }) {
  const client = useQueryClient();
  const [refusal, setRefusal] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: () => updateCoupon(coupon.code, { isActive: !coupon.isActive }),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ["coupons"] });
      toast.success(saved.isActive ? `${saved.code} switched on.` : `${saved.code} switched off.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: () => deleteCoupon(coupon.code),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["coupons"] });
      toast.success(`${coupon.code} deleted.`);
    },
    onError: (error: unknown) => {
      const redemptions = redemptionsBlocking(error);
      if (redemptions !== null) {
        /*
         * Not a failure to report and move on from. `coupon_redemptions.coupon_id` is
         * `ON DELETE RESTRICT` precisely so a campaign's redemption history outlives it, and the
         * server counts the rows *before* attempting the delete so the operator gets this sentence
         * instead of a 500 naming a constraint. Rendered in the row rather than only in a toast,
         * because a toast is gone before the operator has decided what to do instead.
         */
        setRefusal(
          `Cannot be deleted: it has been redeemed ${String(redemptions)} ${redemptions === 1 ? "time" : "times"}, and that history has to survive the campaign. Switch it off instead.`,
        );
        toast.error(errorMessage(error));
        return;
      }
      toast.error(errorMessage(error));
    },
  });

  const conditions: string[] = [];
  if (coupon.minOrderValue !== null) conditions.push(`Min ${inr(coupon.minOrderValue)}`);
  if (coupon.appliesTo === "category") conditions.push("One category");
  if (coupon.channel !== "all")
    conditions.push(coupon.channel === "bulk" ? "B2B only" : "B2C only");
  if (coupon.firstOrderOnly) conditions.push("First order only");
  if (coupon.usageLimitPerUser !== null) {
    conditions.push(`${String(coupon.usageLimitPerUser)} per customer`);
  }

  return (
    <Tr>
      <Td>
        <span className="tnum font-medium">{coupon.code}</span>
        {refusal !== null && (
          <span role="alert" className="text-destructive mt-1 block max-w-72 text-[11px]">
            {refusal}
          </span>
        )}
      </Td>
      <Td>{discountLabel(coupon)}</Td>
      <Td className="text-muted-foreground max-w-56 text-[11px]">
        {conditions.length === 0 ? "None" : conditions.join(" · ")}
      </Td>
      <Td numeric>
        <span className="tnum">
          {count(coupon.timesRedeemed)}
          {coupon.usageLimit === null ? "" : ` / ${count(coupon.usageLimit)}`}
        </span>
      </Td>
      <Td className="text-muted-foreground tnum text-[11px] whitespace-nowrap">
        {coupon.startsAt === null ? "Open" : dateTime(coupon.startsAt)}
        {" → "}
        {coupon.expiresAt === null ? "No end" : dateTime(coupon.expiresAt)}
      </Td>
      <Td>
        <CouponStateBadge coupon={coupon} />
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate()}
          >
            {coupon.isActive ? "Switch off" : "Switch on"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              setRefusal(null);
              remove.mutate();
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Td>
    </Tr>
  );
}
