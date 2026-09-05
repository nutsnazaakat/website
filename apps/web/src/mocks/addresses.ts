import type { SavedAddress } from "@/features/account/types";

/**
 * Seeded address books, keyed by account email. A newly registered account starts with
 * none, which is the honest state — the addresses page shows its empty state instead of
 * pretending someone else's address is theirs.
 */
export const addressBook: Record<string, SavedAddress[]> = {
  "b2c@demo.in": [
    {
      id: "adr-b2c-home",
      label: "Home",
      isDefault: true,
      fullName: "Asha Rao",
      phone: "9876543210",
      email: "b2c@demo.in",
      line1: "12 Residency Road",
      line2: "Near Mayo Hall",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560025",
    },
    {
      id: "adr-b2c-office",
      label: "Office",
      isDefault: false,
      fullName: "Asha Rao",
      phone: "9876543210",
      email: "b2c@demo.in",
      line1: "4th Floor, Prestige Atrium, Central Street",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
    },
  ],
  "b2b@demo.in": [
    {
      id: "adr-b2b-warehouse",
      label: "Warehouse",
      isDefault: true,
      fullName: "Rakesh Anand",
      phone: "9845012345",
      email: "b2b@demo.in",
      line1: "Unit 7, Peenya Industrial Area, Phase II",
      line2: "Goods entrance on the rear road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560058",
    },
  ],
};
