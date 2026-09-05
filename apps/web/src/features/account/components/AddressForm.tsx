import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useForm, type Control, type FieldPath } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { addressSchema, INDIAN_STATES } from "@/features/checkout/schema";
import type { SavedAddress } from "../types";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/** The checkout address plus the two things an address book needs: a name and a default. */
export const savedAddressSchema = addressSchema.extend({
  label: z.string().min(2, "Name this address, e.g. Home"),
  isDefault: z.boolean(),
});

export type SavedAddressValues = z.infer<typeof savedAddressSchema>;

const emptyValues: SavedAddressValues = {
  label: "",
  fullName: "",
  phone: "",
  email: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  pincode: "",
  isDefault: false,
};

function TextField({
  control,
  name,
  label,
  type,
  maxLength,
  className,
}: {
  control: Control<SavedAddressValues>;
  name: FieldPath<SavedAddressValues>;
  label: string;
  type?: string;
  maxLength?: number;
  className?: string;
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
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function AddressForm({
  editing,
  saving,
  onSubmit,
  onCancel,
}: {
  editing: SavedAddress | null;
  saving: boolean;
  onSubmit: (values: SavedAddressValues) => void;
  onCancel?: () => void;
}) {
  const form = useForm<SavedAddressValues, unknown, SavedAddressValues>({
    resolver: zodResolver<SavedAddressValues, unknown, SavedAddressValues>(savedAddressSchema),
    defaultValues: editing ? { ...emptyValues, ...editing } : emptyValues,
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((values) => {
          onSubmit(values);
          if (!editing) form.reset(emptyValues);
        })}
        className="mt-5 grid gap-4 sm:grid-cols-2"
      >
        <TextField control={form.control} name="label" label="Address name" />
        <TextField control={form.control} name="fullName" label="Full name" />
        <TextField control={form.control} name="phone" label="Mobile number" maxLength={10} />
        <TextField control={form.control} name="email" label="Email" type="email" />
        <TextField control={form.control} name="line1" label="Address" className="sm:col-span-2" />
        <TextField
          control={form.control}
          name="line2"
          label="Landmark (optional)"
          className="sm:col-span-2"
        />
        <TextField control={form.control} name="city" label="City" />
        <FormField
          control={form.control}
          name="state"
          render={({ field }) => (
            <FormItem>
              <FormLabel>State</FormLabel>
              <FormControl>
                <select className={SELECT_CLASS} {...field}>
                  <option value="">Select a state</option>
                  {INDIAN_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <TextField control={form.control} name="pincode" label="Pincode" maxLength={6} />

        <FormField
          control={form.control}
          name="isDefault"
          render={({ field }) => (
            <FormItem className="flex items-center gap-3 sm:pt-8">
              <FormControl>
                <Checkbox
                  checked={field.value === true}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
              </FormControl>
              <FormLabel className="!mt-0">Use as my default address</FormLabel>
            </FormItem>
          )}
        />

        <div className="flex flex-wrap gap-3 sm:col-span-2">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" /> Saving…
              </>
            ) : editing ? (
              "Save Changes"
            ) : (
              "Add Address"
            )}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Form>
  );
}
