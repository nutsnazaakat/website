import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useForm, type Control, type FieldPath } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { useAddresses } from "@/features/account/hooks/useAccount";
import type { SavedAddress } from "@/features/account/types";
import {
  useUpdateBusinessProfile,
  useBusinessProfile,
} from "@/features/business/hooks/useBusiness";
import { GSTIN_REGEX, PHONE_REGEX } from "@/features/checkout/schema";
import { BUSINESS_TYPES } from "@/features/rfq/schema";
import { useSeo } from "@/hooks/useSeo";
import type { BusinessProfile } from "@/contract";

export const Route = createFileRoute("/business/profile")({ component: BusinessProfilePage });

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * `billingAddressId`/`shippingAddressId` are ids from the caller's own address book, or `""` —
 * the native `<select>`'s only way to say "nothing chosen" — converted to `null` at submission.
 * There is no inline address here any more; see the route component's own docblock for why.
 */
const profileSchema = z.object({
  companyName: z.string().min(2, "Enter your company name"),
  contactPerson: z.string().min(2, "Enter a contact person"),
  mobile: z.string().regex(PHONE_REGEX, "Enter a valid 10-digit Indian mobile number"),
  gstin: z
    .string()
    .refine((v) => v === "" || GSTIN_REGEX.test(v), "Enter a valid 15-character GSTIN")
    .optional(),
  businessType: z.string().min(1, "Select your business type"),
  billingAddressId: z.string(),
  shippingAddressId: z.string(),
});

type ProfileValues = z.infer<typeof profileSchema>;

function defaultsFor(profile: BusinessProfile): ProfileValues {
  return {
    companyName: profile.companyName,
    contactPerson: profile.contactPerson,
    mobile: profile.mobile,
    gstin: profile.gstin ?? "",
    businessType: profile.businessType,
    billingAddressId: profile.billingAddress?.id ?? "",
    shippingAddressId: profile.shippingAddress?.id ?? "",
  };
}

function TextField({
  control,
  name,
  label,
  type,
  description,
  className,
  maxLength,
  upperCase,
}: {
  control: Control<ProfileValues>;
  name: FieldPath<ProfileValues>;
  label: string;
  type?: string;
  description?: string;
  className?: string;
  maxLength?: number;
  upperCase?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type={type}
              maxLength={maxLength}
              {...field}
              value={typeof field.value === "string" ? field.value : ""}
              onChange={(e) =>
                field.onChange(upperCase ? e.target.value.toUpperCase() : e.target.value)
              }
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * One of the two address selects, per brief §19's "these details prefill your bulk invoices and
 * dispatch paperwork" — but Task 15 settled that the two fields are **references** into the
 * address book, not a second pair of inline addresses, so this renders a select over it rather
 * than a form.
 *
 * Three states, and only one of them is a select at all:
 *
 * - **The book is empty.** No option can be offered, so none is — a select with nothing in it
 *   looks broken rather than explaining why. A link to `/account/addresses` and a sentence
 *   saying what to do stands in its place.
 * - **The book has addresses.** A select, options in the book's own default-first order —
 *   `GET /account/addresses` already answers that way — so the customer's default address is
 *   the first thing they see, not necessarily the one already chosen.
 *
 * The third state — the book has addresses but this field points at none — is not a branch
 * here at all: it is simply the select rendering its own placeholder option, selected, because
 * `defaultsFor` gives it `""` for an unset reference. Nothing distinguishes "never chosen" from
 * "book is not loaded yet" at this component's level, and nothing needs to: the page only
 * mounts this once the book has loaded.
 */
function AddressSelect({
  control,
  name,
  label,
  addresses,
}: {
  control: Control<ProfileValues>;
  name: "billingAddressId" | "shippingAddressId";
  label: string;
  addresses: SavedAddress[];
}) {
  if (addresses.length === 0) {
    return (
      <div className="sm:col-span-2">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          You have no saved addresses yet.{" "}
          <Link to="/account/addresses" className="underline underline-offset-4">
            Add one
          </Link>{" "}
          to choose it here.
        </p>
      </div>
    );
  }

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <select className={SELECT_CLASS} {...field}>
              <option value="">Not set</option>
              {addresses.map((address) => (
                <option key={address.id} value={address.id}>
                  {address.label} — {address.line1}, {address.city}
                </option>
              ))}
            </select>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * The form itself, mounted only once both the profile and the address book have loaded —
 * `ContactDetails` in `routes/account/profile.tsx` gates the identical way, for the identical
 * reason: `defaultValues` are read once, at mount, and a form that mounted before its data
 * arrived would need a second mechanism to reset itself when that data showed up.
 */
function ProfileForm({
  profile,
  addresses,
}: {
  profile: BusinessProfile;
  addresses: SavedAddress[];
}) {
  const updateProfile = useUpdateBusinessProfile();

  const form = useForm<ProfileValues, unknown, ProfileValues>({
    resolver: zodResolver<ProfileValues, unknown, ProfileValues>(profileSchema),
    defaultValues: defaultsFor(profile),
  });

  const onSubmit = async (values: ProfileValues) => {
    try {
      const gstin = values.gstin?.trim();
      const saved = await updateProfile.mutateAsync({
        companyName: values.companyName,
        contactPerson: values.contactPerson,
        mobile: values.mobile,
        ...(gstin ? { gstin } : {}),
        businessType: values.businessType,
        billingAddressId: values.billingAddressId === "" ? null : values.billingAddressId,
        shippingAddressId: values.shippingAddressId === "" ? null : values.shippingAddressId,
      });
      // Re-synced from what the server actually saved, not an echo of what was submitted — a
      // cleared GSTIN answers back as `undefined`, and this is what keeps the field empty
      // rather than "dirty" against a value the server never stored.
      form.reset(defaultsFor(saved));
      toast.success("Business profile saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save. Please try again.");
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={(event) => {
          void form.handleSubmit(onSubmit)(event);
        }}
        className="mt-8 space-y-6"
      >
        <section className="border-border rounded-2xl border p-5 sm:p-6">
          <h2 className="font-display text-2xl">Company</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <TextField control={form.control} name="companyName" label="Company name" />
            <TextField control={form.control} name="contactPerson" label="Contact person" />
            <TextField control={form.control} name="mobile" label="Mobile number" maxLength={10} />
            <TextField
              control={form.control}
              name="gstin"
              label="GSTIN (optional)"
              maxLength={15}
              upperCase
              description="Needed for an input-credit invoice."
            />
            <FormField
              control={form.control}
              name="businessType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business type</FormLabel>
                  <FormControl>
                    <select className={SELECT_CLASS} {...field}>
                      <option value="">Select a business type</option>
                      {BUSINESS_TYPES.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="border-border rounded-2xl border p-5 sm:p-6">
          <h2 className="font-display text-2xl">Addresses</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Chosen from your saved address book — the same one{" "}
            <Link to="/account/addresses" className="underline underline-offset-4">
              Account → Addresses
            </Link>{" "}
            manages.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <AddressSelect
              control={form.control}
              name="billingAddressId"
              label="Billing address"
              addresses={addresses}
            />
            <AddressSelect
              control={form.control}
              name="shippingAddressId"
              label="Shipping address"
              addresses={addresses}
            />
          </div>
        </section>

        <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Saving…
            </>
          ) : (
            "Save Profile"
          )}
        </Button>
      </form>
    </Form>
  );
}

/**
 * Brief §19's business profile — Task 18's rewiring off the last `localStorage` overlay.
 *
 * `nn.business-profile.v1` is gone: it keyed a `localStorage` snapshot this route wrote and read
 * back itself, so "Business Profile saved" was true of the browser and of nothing else — a
 * second business login, or the same one from a different device, saw whatever had last been
 * typed on this one. `GET`/`PUT /business/me` (Task 15) replace it. After this task,
 * `grep -rn "localStorage" frontend/src` finds only the auth snapshot `AuthProvider` owns and
 * test hygiene — nothing else in the tree keeps its own copy of anything the server now answers.
 *
 * The old form also asked for an `email` field that `Business` has never had a column for —
 * measured against the entity, not merely dropped for tidiness — and for two inline addresses
 * where `Business.billingAddressId`/`.shippingAddressId` are references into the address book
 * Plan 3 already built. Both gaps are why this page is now this thin: less to validate, because
 * less of it was ever real.
 */
function BusinessProfilePage() {
  useSeo({
    title: `Business Profile | ${settings.brandName}`,
    description: "Company details, GSTIN and the addresses we bill and ship to.",
  });

  const { data: profile, isLoading: profileLoading } = useBusinessProfile();
  const { data: addresses, isLoading: addressesLoading } = useAddresses();

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl">Business Profile</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        These details prefill your bulk invoices and dispatch paperwork.
      </p>

      {profileLoading || addressesLoading ? (
        <div className="mt-8 space-y-4">
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : profile ? (
        <ProfileForm profile={profile} addresses={addresses ?? []} />
      ) : (
        <p className="text-muted-foreground mt-8 text-sm">
          Could not load your business profile. Please refresh the page.
        </p>
      )}
    </div>
  );
}
