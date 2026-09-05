import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type {
  AdminCoupon,
  AdminCouponChannel,
  AdminCouponScope,
  AdminCouponType,
} from "@/contract";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Panel, PanelHeader } from "@/components/ui/panel";
import {
  COUPON_CHANNELS,
  COUPON_SCOPES,
  COUPON_TYPES,
  createCoupon,
  fetchCategoryOptions,
  updateCoupon,
  type CouponInput,
} from "@/features/coupons/api/coupons";
import { errorMessage } from "@/features/orders/api/errors";

/**
 * Brief §36's nine levers, in one form: percentage discount, flat discount, minimum order value,
 * category-specific, B2C-only, B2B-only, first-order, expiry and usage limit.
 *
 * **The code is editable only while creating.** `UpdateCouponDto` omits the field entirely, and the
 * screen must say why rather than rendering a disabled box with no explanation: the code is what
 * `orders.couponCode` snapshotted onto every order that used it, what the audit trail records, and
 * what this page's own URL addresses. Renaming would orphan all three.
 *
 * **Type and value are always sent together.** `AdminCouponsService` refuses a coupon whose type
 * and value disagree with a named 422 — and its own docblock explains that a bare
 * `PATCH {"type": "flat"}` reaches `ck_coupons_value_exclusive` with the percentage still populated
 * and surfaces as a 500. Sending both sides on every save, with the unused one explicitly `null`,
 * is what keeps that unreachable from this screen.
 */

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in the browser's own timezone. */
function toLocalInput(iso: string | null): string {
  if (iso === null) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Back to an instant.
 *
 * A coupon window is a genuine moment — "the sale ends at midnight" — not a business calendar day,
 * so the browser's timezone is the right one to read it in. That is the opposite of the order
 * list's `from`/`to`, which are calendar days resolved server-side in the business timezone, and
 * the difference is deliberate rather than an inconsistency: those bound a day, this bounds an
 * instant.
 */
function toIso(local: string): string | null {
  if (local === "") return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function numberOrNull(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function intOrNull(raw: string): number | null | undefined {
  const parsed = numberOrNull(raw);
  if (parsed === undefined || parsed === null) return parsed;
  return Number.isInteger(parsed) ? parsed : undefined;
}

interface FormState {
  code: string;
  type: AdminCouponType;
  percentValue: string;
  flatValue: string;
  minOrderValue: string;
  maxDiscount: string;
  appliesTo: AdminCouponScope;
  categoryId: string;
  channel: AdminCouponChannel;
  firstOrderOnly: boolean;
  usageLimit: string;
  usageLimitPerUser: string;
  startsAt: string;
  expiresAt: string;
  isActive: boolean;
}

function blankForm(): FormState {
  return {
    code: "",
    type: "percent",
    percentValue: "",
    flatValue: "",
    minOrderValue: "",
    maxDiscount: "",
    appliesTo: "all",
    categoryId: "",
    channel: "all",
    firstOrderOnly: false,
    usageLimit: "",
    usageLimitPerUser: "",
    startsAt: "",
    expiresAt: "",
    isActive: true,
  };
}

function formFrom(coupon: AdminCoupon): FormState {
  return {
    code: coupon.code,
    type: coupon.type,
    percentValue: coupon.percentValue === null ? "" : String(coupon.percentValue),
    flatValue: coupon.flatValue === null ? "" : String(coupon.flatValue),
    minOrderValue: coupon.minOrderValue === null ? "" : String(coupon.minOrderValue),
    maxDiscount: coupon.maxDiscount === null ? "" : String(coupon.maxDiscount),
    appliesTo: coupon.appliesTo,
    categoryId: coupon.categoryId ?? "",
    channel: coupon.channel,
    firstOrderOnly: coupon.firstOrderOnly,
    usageLimit: coupon.usageLimit === null ? "" : String(coupon.usageLimit),
    usageLimitPerUser: coupon.usageLimitPerUser === null ? "" : String(coupon.usageLimitPerUser),
    startsAt: toLocalInput(coupon.startsAt),
    expiresAt: toLocalInput(coupon.expiresAt),
    isActive: coupon.isActive,
  };
}

export function CouponForm({
  coupon,
  onDone,
}: {
  /** `null` creates. Anything else edits that coupon, with its code frozen. */
  coupon: AdminCoupon | null;
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState<FormState>(coupon === null ? blankForm() : formFrom(coupon));

  const categories = useQuery({
    queryKey: ["coupon-categories"],
    queryFn: ({ signal }) => fetchCategoryOptions(signal),
    // Only needed for a category-scoped coupon, and the list is a fixed navigation surface that
    // does not change under an operator mid-form.
    enabled: form.appliesTo === "category",
    staleTime: 5 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: (input: CouponInput) =>
      coupon === null
        ? createCoupon(form.code.trim().toUpperCase(), input)
        : updateCoupon(coupon.code, input),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ["coupons"] });
      toast.success(coupon === null ? `Coupon ${saved.code} created.` : `${saved.code} saved.`);
      onDone();
    },
    onError: (error: unknown) => {
      // The server's messages here are written for a human and are more useful than anything this
      // form could restate — "That usage limit is below the number of times this coupon has already
      // been redeemed…" names the rule and the alternative in one sentence.
      toast.error(errorMessage(error));
    },
  });

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [key]: value }));
  }

  function submit() {
    const percentValue = numberOrNull(form.percentValue);
    const flatValue = numberOrNull(form.flatValue);
    const minOrderValue = numberOrNull(form.minOrderValue);
    const maxDiscount = numberOrNull(form.maxDiscount);
    const usageLimit = intOrNull(form.usageLimit);
    const usageLimitPerUser = intOrNull(form.usageLimitPerUser);

    if (
      percentValue === undefined ||
      flatValue === undefined ||
      minOrderValue === undefined ||
      maxDiscount === undefined
    ) {
      toast.error("Every amount must be a number of rupees, or blank.");
      return;
    }
    if (usageLimit === undefined || usageLimitPerUser === undefined) {
      toast.error("A usage limit must be a whole number, or blank.");
      return;
    }
    if (coupon === null && form.code.trim() === "") {
      toast.error("A coupon needs a code.");
      return;
    }
    if (form.appliesTo === "category" && form.categoryId === "") {
      toast.error("A category-scoped coupon needs a category.");
      return;
    }

    const percent = form.type === "percent";
    mutation.mutate({
      type: form.type,
      // Both sides, always, with the unused one cleared. See this file's docblock.
      percentValue: percent ? percentValue : null,
      flatValue: percent ? null : flatValue,
      minOrderValue,
      // A cap on a flat coupon is stored, shown and then ignored by `applyFlat`, so the server
      // refuses it outright. Cleared here rather than sent and rejected.
      maxDiscount: percent ? maxDiscount : null,
      appliesTo: form.appliesTo,
      categoryId: form.appliesTo === "category" ? form.categoryId : null,
      channel: form.channel,
      firstOrderOnly: form.firstOrderOnly,
      usageLimit,
      usageLimitPerUser,
      startsAt: toIso(form.startsAt),
      expiresAt: toIso(form.expiresAt),
      isActive: form.isActive,
    });
  }

  return (
    <Panel>
      <PanelHeader
        title={coupon === null ? "New coupon" : `Edit ${coupon.code}`}
        hint={
          coupon === null
            ? "Brief §36"
            : `${String(coupon.timesRedeemed)} ${coupon.timesRedeemed === 1 ? "redemption" : "redemptions"} so far`
        }
        action={
          <Button variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        }
      />
      <form
        className="flex flex-col gap-3 px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code" htmlFor="coupon-code">
            {coupon === null ? (
              <Input
                id="coupon-code"
                required
                maxLength={40}
                placeholder="DIWALI25"
                value={form.code}
                onChange={(event) => set("code", event.target.value.toUpperCase())}
              />
            ) : (
              <Input id="coupon-code" value={coupon.code} readOnly disabled />
            )}
          </Field>

          <Field label="Discount type" htmlFor="coupon-type">
            <Select
              id="coupon-type"
              value={form.type}
              onChange={(event) => {
                const next = COUPON_TYPES.find((type) => type === event.target.value);
                if (next !== undefined) set("type", next);
              }}
            >
              {COUPON_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === "percent" ? "Percentage off" : "Flat amount off"}
                </option>
              ))}
            </Select>
          </Field>

          {form.type === "percent" ? (
            <Field label="Percentage (1–100)" htmlFor="coupon-percent">
              <Input
                id="coupon-percent"
                inputMode="decimal"
                value={form.percentValue}
                onChange={(event) => set("percentValue", event.target.value)}
              />
            </Field>
          ) : (
            <Field label="Flat amount (₹)" htmlFor="coupon-flat">
              <Input
                id="coupon-flat"
                inputMode="decimal"
                value={form.flatValue}
                onChange={(event) => set("flatValue", event.target.value)}
              />
            </Field>
          )}

          <Field label="Minimum order value (₹)" htmlFor="coupon-min">
            <Input
              id="coupon-min"
              inputMode="decimal"
              placeholder="Blank for none"
              value={form.minOrderValue}
              onChange={(event) => set("minOrderValue", event.target.value)}
            />
          </Field>

          {form.type === "percent" && (
            <Field label="Maximum discount (₹)" htmlFor="coupon-max">
              <Input
                id="coupon-max"
                inputMode="decimal"
                placeholder="Blank for uncapped"
                value={form.maxDiscount}
                onChange={(event) => set("maxDiscount", event.target.value)}
              />
            </Field>
          )}

          <Field label="Applies to" htmlFor="coupon-scope">
            <Select
              id="coupon-scope"
              value={form.appliesTo}
              onChange={(event) => {
                const next = COUPON_SCOPES.find((scope) => scope === event.target.value);
                if (next !== undefined) set("appliesTo", next);
              }}
            >
              {COUPON_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope === "all" ? "The whole basket" : "One category"}
                </option>
              ))}
            </Select>
          </Field>

          {form.appliesTo === "category" && (
            <Field label="Category" htmlFor="coupon-category">
              <Select
                id="coupon-category"
                value={form.categoryId}
                onChange={(event) => set("categoryId", event.target.value)}
              >
                <option value="">{categories.isPending ? "Loading…" : "Choose a category"}</option>
                {(categories.data ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Storefront" htmlFor="coupon-channel">
            <Select
              id="coupon-channel"
              value={form.channel}
              onChange={(event) => {
                const next = COUPON_CHANNELS.find((channel) => channel === event.target.value);
                if (next !== undefined) set("channel", next);
              }}
            >
              {COUPON_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel === "all"
                    ? "Both (B2C and B2B)"
                    : channel === "retail"
                      ? "B2C only (retail)"
                      : "B2B only (bulk)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Total redemptions allowed" htmlFor="coupon-limit">
            <Input
              id="coupon-limit"
              inputMode="numeric"
              placeholder="Blank for unlimited"
              value={form.usageLimit}
              onChange={(event) => set("usageLimit", event.target.value)}
            />
          </Field>

          <Field label="Redemptions per customer" htmlFor="coupon-limit-user">
            <Input
              id="coupon-limit-user"
              inputMode="numeric"
              placeholder="Blank for unlimited"
              value={form.usageLimitPerUser}
              onChange={(event) => set("usageLimitPerUser", event.target.value)}
            />
          </Field>

          <Field label="Starts" htmlFor="coupon-starts">
            <Input
              id="coupon-starts"
              type="datetime-local"
              value={form.startsAt}
              onChange={(event) => set("startsAt", event.target.value)}
            />
          </Field>

          <Field label="Expires" htmlFor="coupon-expires">
            <Input
              id="coupon-expires"
              type="datetime-local"
              value={form.expiresAt}
              onChange={(event) => set("expiresAt", event.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={form.firstOrderOnly}
              onChange={(event) => set("firstOrderOnly", event.target.checked)}
            />
            First order only
          </label>
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => set("isActive", event.target.checked)}
            />
            Active
          </label>
        </div>

        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : coupon === null ? "Create coupon" : "Save changes"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>

        <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-4 text-[11px]">
          <li>
            The code cannot be changed once the coupon exists — the order snapshot, the audit trail
            and this screen&rsquo;s link all key on it.
          </li>
          <li>
            An expiry in the past is <strong className="font-medium">allowed</strong>: it is how a
            campaign ends at a stated moment. The coupon stops working and its history stays.
          </li>
          <li>
            A total limit below the redemptions already taken is{" "}
            <strong className="font-medium">refused</strong>, because it would kill the coupon
            silently behind a successful save. Untick <em>Active</em> instead.
          </li>
          <li>
            Dates are read in this browser&rsquo;s timezone — a coupon window is a moment, not a
            business day.
          </li>
        </ul>
      </form>
    </Panel>
  );
}
