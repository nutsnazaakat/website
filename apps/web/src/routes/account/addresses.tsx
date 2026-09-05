import { createFileRoute } from "@tanstack/react-router";
import { MapPin, Pencil, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { settings } from "@/config/settings";
import { AddressForm, type SavedAddressValues } from "@/features/account/components/AddressForm";
import { useAddresses, useAddressMutations } from "@/features/account/hooks/useAccount";
import type { SavedAddress } from "@/features/account/types";
import { useSeo } from "@/hooks/useSeo";

export const Route = createFileRoute("/account/addresses")({ component: AccountAddresses });

function AddressCard({
  address,
  onEdit,
  onRemove,
  onMakeDefault,
}: {
  address: SavedAddress;
  onEdit: () => void;
  onRemove: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <li className="border-border rounded-2xl border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-semibold">{address.label}</p>
        {address.isDefault && <Badge variant="secondary">Default</Badge>}
      </div>
      <address className="text-muted-foreground mt-2 text-sm not-italic">
        <span className="block">{address.fullName}</span>
        <span className="block">{address.line1}</span>
        {address.line2 && <span className="block">{address.line2}</span>}
        <span className="block">
          {address.city}, {address.state} {address.pincode}
        </span>
        <span className="block">{address.phone}</span>
      </address>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="mr-2 size-3.5" /> Edit
        </Button>
        {!address.isDefault && (
          <>
            <Button variant="ghost" size="sm" onClick={onMakeDefault}>
              <Star className="mr-2 size-3.5" /> Make default
            </Button>
            <Button variant="ghost" size="sm" onClick={onRemove}>
              <Trash2 className="mr-2 size-3.5" /> Remove
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function AccountAddresses() {
  // No email anywhere on this page. All five address endpoints are scoped by the session cookie, and
  // `/account` is behind `requireCustomer` in the layout's `beforeLoad`, so there is no signed-out
  // state to render and nothing for a client to name.
  const { data: addresses, isLoading } = useAddresses();
  const { save, remove, setDefault } = useAddressMutations();
  const [editing, setEditing] = useState<SavedAddress | null>(null);

  useSeo({
    title: `Your Addresses | ${settings.brandName}`,
    description: "Delivery addresses saved to your account.",
    noindex: true,
  });

  const list = addresses ?? [];

  /**
   * **The id comes from the address being edited, or from nowhere at all.**
   *
   * This used to mint `` `adr-${Date.now().toString(36)}` `` for a new address so that every save
   * could be an upsert against a client-side array. Two problems, and the second is the one that
   * bites: `Date.now()` collides for two addresses saved in the same millisecond, and the value is
   * not a uuid, so against the real `addresses.id` column it is a `ParseUUIDPipe` 400 — or, without
   * that pipe, SQLSTATE `22P02` and a 500. `id: null` is what tells `useAddressMutations` to POST
   * rather than PATCH, and the server allocates the uuid.
   */
  const onSubmit = (values: SavedAddressValues) => {
    save.mutate(
      { id: editing?.id ?? null, values },
      {
        onSuccess: () => {
          toast.success(editing ? "Address updated" : "Address added");
          setEditing(null);
        },
      },
    );
  };

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl">Your Addresses</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Saved addresses prefill checkout. The default one is offered first.
      </p>

      {isLoading ? (
        <div className="mt-6 space-y-3">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="No addresses saved yet."
          body="Add one here and it will be offered at checkout."
          icon={<MapPin className="size-10" />}
        />
      ) : (
        <ul aria-label="Saved addresses" className="mt-6 grid gap-4 sm:grid-cols-2">
          {list.map((a) => (
            <AddressCard
              key={a.id}
              address={a}
              onEdit={() => setEditing(a)}
              onRemove={() =>
                remove.mutate(a.id, { onSuccess: () => toast.success("Address removed") })
              }
              onMakeDefault={() =>
                setDefault.mutate(a.id, {
                  onSuccess: () => toast.success("Default address updated"),
                })
              }
            />
          ))}
        </ul>
      )}

      <section className="border-border mt-8 rounded-2xl border p-5 sm:p-6">
        <h2 className="font-display text-2xl">
          {editing ? `Edit ${editing.label}` : "Add a new address"}
        </h2>
        {/* Keyed so switching between add and edit rebuilds the form with the right values. */}
        <AddressForm
          key={editing?.id ?? "new"}
          editing={editing}
          saving={save.isPending}
          onSubmit={onSubmit}
          onCancel={editing ? () => setEditing(null) : undefined}
        />
      </section>
    </div>
  );
}
