import type {
  AdminAuditLogEntry,
  AdminBlogPost,
  AdminCoupon,
  AdminReview,
  AdminSetting,
  AdminSupportTicket,
  AdminSupportTicketSummary,
} from "@/contract";

/**
 * Fixtures for the operations screens — coupons, reviews, the blog, support, settings and the audit
 * log — shaped from what the admin endpoints actually return.
 *
 * **Money is rupees**, as it is on the wire: `flatValue: 500` is five hundred rupees off, and
 * `minOrderValue: 2000` is a two-thousand-rupee basket. A fixture written in paise would let a
 * screen that divided by a hundred pass while telling an operator a ₹500 coupon was worth ₹5.
 *
 * Beside `catalogue-fixtures.ts` and `people-fixtures.ts` rather than inside `server.ts`, following
 * the shape plan 9.6b's other group established: the harness (`installApi`, `page`, `apiError`)
 * stays in one place, and each group of screens brings its own data.
 */

export const REDEEMED_COUPON: AdminCoupon = {
  code: "DIWALI25",
  type: "percent",
  percentValue: 25,
  flatValue: null,
  minOrderValue: 2000,
  maxDiscount: 500,
  appliesTo: "all",
  categoryId: null,
  channel: "retail",
  firstOrderOnly: false,
  usageLimit: 100,
  usageLimitPerUser: 1,
  // The reason it cannot be deleted: `coupon_redemptions` is ON DELETE RESTRICT.
  timesRedeemed: 14,
  startsAt: null,
  expiresAt: null,
  isActive: true,
  createdAt: "2026-08-01T04:00:00.000Z",
  updatedAt: "2026-08-01T04:00:00.000Z",
};

export const FRESH_COUPON: AdminCoupon = {
  ...REDEEMED_COUPON,
  code: "WELCOME10",
  type: "flat",
  percentValue: null,
  // Rupees.
  flatValue: 500,
  maxDiscount: null,
  minOrderValue: null,
  channel: "all",
  firstOrderOnly: true,
  usageLimit: null,
  usageLimitPerUser: null,
  timesRedeemed: 0,
};

export const PENDING_REVIEW: AdminReview = {
  id: "7f0f6c9e-0000-4000-8000-0000000000r1",
  productSlug: "premium-california-almonds",
  author: "Meera Iyer",
  rating: 4,
  body: "Fresh and crunchy. The 500g pack is good value, though the seal could be sturdier.",
  verifiedPurchase: true,
  status: "pending",
  createdAt: "2026-08-24T06:30:00.000Z",
  userId: "420762ba-9b8a-4235-a8cf-f1c3e2868f06",
  moderatedByUserId: null,
  moderatedAt: null,
  rejectionReason: null,
};

export const APPROVED_REVIEW: AdminReview = {
  ...PENDING_REVIEW,
  status: "approved",
  moderatedByUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
  moderatedAt: "2026-08-27T04:00:00.000Z",
};

export const PUBLISHED_POST: AdminBlogPost = {
  slug: "how-to-store-dry-fruits-at-home",
  title: "How to Store Dry Fruits at Home",
  category: "Storage Tips",
  excerpt: "Airtight, cool and dark, in that order of importance.",
  image: "https://images.example.com/storage.jpg",
  author: "Nuts & Nazaakat",
  body: "Dry fruits go stale for two reasons: air and warmth.",
  isPublished: true,
  publishedAt: "2026-07-02T04:00:00.000Z",
  seo: {
    title: "How to Store Dry Fruits at Home | Nuts & Nazaakat",
    description: "Airtight, cool and dark.",
    ogImage: "",
  },
  createdAt: "2026-07-01T04:00:00.000Z",
  updatedAt: "2026-07-02T04:00:00.000Z",
};

export const DRAFT_POST: AdminBlogPost = {
  ...PUBLISHED_POST,
  slug: "w320-vs-w240-cashews",
  title: "W320 vs W240 Cashews: What's the Difference?",
  category: "Buying Guides",
  isPublished: false,
  // A draft has never gone live — nullable here and never on the public shape.
  publishedAt: null,
};

export const TICKET_SUMMARY: AdminSupportTicketSummary = {
  ticketNumber: "ST-2026-000318",
  name: "Vikram Shah",
  email: "vikram@example.in",
  phone: "9812345670",
  topic: "An order I have placed",
  status: "new",
  priority: 1,
  // A soft link: the customer typed it and nothing checked it against the orders table.
  orderNumber: "NN-2026-005107",
  assignedToUserId: null,
  userId: null,
  createdAt: "2026-08-26T10:15:00.000Z",
  resolvedAt: null,
};

export const TICKET_DETAIL: AdminSupportTicket = {
  ...TICKET_SUMMARY,
  message: "My order says out for delivery but nothing arrived yesterday. Can you check?",
  updatedAt: "2026-08-26T10:15:00.000Z",
  notes: [
    {
      id: "tnote-1",
      body: "Courier says reattempt today.",
      isInternal: true,
      authorUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
      authorName: "Nazaakat Admin",
      createdAt: "2026-08-26T11:00:00.000Z",
    },
  ],
};

/**
 * The seeded settings table, including the deliberately-empty ones.
 *
 * `whatsappNumber`, `gstin`, `fssaiLicence` and `certifications` are blank because brief §26 and §37
 * forbid inventing them — that emptiness is the fixture's whole point, since it is the state the
 * settings screen has to explain rather than paper over.
 */
export const SETTINGS: AdminSetting[] = [
  {
    key: "brandName",
    value: "Nuts & Nazaakat",
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "business.timezone",
    value: "Asia/Kolkata",
    isPublic: false,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "certifications",
    value: [],
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "codEnabled",
    value: true,
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "freeShippingThreshold",
    value: 999,
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "fssaiLicence",
    value: "",
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "gstin",
    value: "",
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    key: "whatsappNumber",
    value: "",
    isPublic: true,
    updatedByUserId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

export const AUDIT_ENTRIES: AdminAuditLogEntry[] = [
  {
    id: "audit-1",
    action: "coupon.delete",
    entity: "coupon",
    entityId: "SUMMER5",
    actorUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
    actorName: "Nazaakat Admin",
    before: { code: "SUMMER5", isActive: true },
    after: null,
    createdAt: "2026-08-25T09:00:00.000Z",
  },
  {
    id: "audit-2",
    action: "setting.update",
    entity: "setting",
    entityId: "whatsappNumber",
    actorUserId: "aa3d37af-2e93-4564-80e4-726217fe8519",
    actorName: "Nazaakat Admin",
    before: { value: "" },
    after: { value: "919876543210" },
    createdAt: "2026-08-26T09:00:00.000Z",
  },
];
