import type {
  AdminBusiness,
  AdminBusinessSummary,
  AdminCustomer,
  AdminCustomerSummary,
  AdminRfq,
  AdminRfqSummary,
} from "@/contract";

/**
 * Fixtures for the people screens, shaped from what the admin endpoints actually return.
 *
 * In a file of its own rather than appended to `src/test/server.ts`, and that is a decision about
 * *merging* rather than about testing: plan 9.6b builds its two groups of screens on concurrent
 * branches, and both would otherwise append to one 200-line fixture module. Two additions at the
 * end of one file is a conflict; two new files is not. `installApi`, `page` and `apiError` still
 * come from `server.ts`, because those are the harness and there must be one of them.
 *
 * **Money is rupees**, as it is on the wire. `totalSpend: 41592.85` is a customer who has spent
 * forty-one thousand rupees — the figure the service returns, not paise. A fixture written in paise
 * would let a screen that divided by a hundred pass its tests while being wrong by 100× in front of
 * an operator deciding a refund.
 */

export const CUSTOMER_ID = "420762ba-9b8a-4235-a8cf-f1c3e2868f06";
export const BUSINESS_ID = "9c2f1b40-0000-4000-8000-00000000b001";
export const BUSINESS_USER_ID = "b1b1b1b1-0000-4000-8000-00000000c001";

export const CUSTOMER_SUMMARY: AdminCustomerSummary = {
  id: CUSTOMER_ID,
  name: "Asha Rao",
  email: "b2c@demo.in",
  phone: "9876543210",
  role: "b2c",
  isActive: true,
  orders: 6,
  totalSpend: 6144.3,
  lastOrderAt: "2026-08-21T07:44:13.405Z",
  createdAt: "2025-01-09T04:00:00.000Z",
};

export const CUSTOMER_DETAIL: AdminCustomer = {
  ...CUSTOMER_SUMMARY,
  lastLoginAt: "2026-08-26T11:02:00.000Z",
  addresses: [
    {
      id: "addr-1",
      label: "Home",
      isDefault: true,
      fullName: "Asha Rao",
      phone: "9876543210",
      email: "b2c@demo.in",
      line1: "12 Brigade Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
    },
  ],
  business: null,
};

export const B2B_CUSTOMER_DETAIL: AdminCustomer = {
  ...CUSTOMER_SUMMARY,
  id: BUSINESS_USER_ID,
  name: "Rakesh Anand",
  email: "b2b@demo.in",
  role: "b2b",
  orders: 2,
  totalSpend: 77348.25,
  lastLoginAt: null,
  addresses: [],
  business: {
    id: BUSINESS_ID,
    companyName: "Anand Sweets & Namkeen",
    gstin: "29ABCDE1234F1Z5",
    businessType: "Sweet shop",
    segment: "distributor",
  },
};

export const BUSINESS_SUMMARY: AdminBusinessSummary = {
  id: BUSINESS_ID,
  userId: BUSINESS_USER_ID,
  companyName: "Anand Sweets & Namkeen",
  contactPerson: "Rakesh Anand",
  mobile: "9845012345",
  email: "b2b@demo.in",
  gstin: "29ABCDE1234F1Z5",
  businessType: "Sweet shop",
  segment: "distributor",
  orders: 2,
  totalSpend: 77348.25,
  lastOrderAt: "2026-08-08T07:44:13.405Z",
  rfqs: 3,
  openRfqs: 2,
  assignedSalesperson: null,
  createdAt: "2025-02-14T04:00:00.000Z",
};

export const BUSINESS_DETAIL: AdminBusiness = {
  ...BUSINESS_SUMMARY,
  billingAddress: {
    id: "addr-b1",
    label: "Registered office",
    isDefault: true,
    fullName: "Rakesh Anand",
    phone: "9845012345",
    email: "b2b@demo.in",
    line1: "44 Commercial Street",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
  },
  shippingAddress: null,
};

export const RFQ_SUMMARY: AdminRfqSummary = {
  id: "RFQ-2026-000412",
  kind: "bulk",
  status: "contacted",
  businessName: "Anand Sweets & Namkeen",
  createdAt: "2026-08-20T09:12:00.000Z",
  contactPerson: "Rakesh Anand",
  mobile: "9845012345",
  email: "b2b@demo.in",
  lines: [
    { productSlug: "premium-california-almonds", kg: 120 },
    { productSlug: "w320-cashews", kg: 80 },
  ],
  totalKg: 200,
  // Rupees. Not 8_450_000 paise.
  expectedValue: 84500,
  assignedSalesperson: null,
};

export const RFQ_DETAIL: AdminRfq = {
  ...RFQ_SUMMARY,
  userId: BUSINESS_USER_ID,
  gstin: "29ABCDE1234F1Z5",
  businessType: "Sweet shop",
  pincode: "560001",
  packaging: "Bulk sacks (25 kg)",
  frequency: "Monthly",
  // The prospect's own words, from the public form. Never the sales trail.
  notes: "We need vacuum packing for the cashews, and delivery before Diwali.",
  gifting: null,
  internalNotes: [
    {
      id: "note-1",
      body: "Rang the buyer; wants 200kg a month from October.",
      authorUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
      authorName: "Nazaakat Admin",
      createdAt: "2026-08-21T05:00:00.000Z",
    },
  ],
  updatedAt: "2026-08-21T05:00:00.000Z",
};

export const GIFTING_RFQ_DETAIL: AdminRfq = {
  ...RFQ_DETAIL,
  id: "RFQ-2026-000413",
  kind: "gifting",
  lines: [],
  totalKg: 0,
  packaging: null,
  frequency: null,
  notes: null,
  gifting: {
    occasion: "Diwali",
    giftBoxSlug: "royal-gift-box",
    boxes: 250,
    // Rupees.
    budgetPerBox: 1200,
    brandingRequired: true,
    deliveryDate: "2026-10-15",
    message: "Company logo on the sleeve, please.",
  },
  internalNotes: [],
};
