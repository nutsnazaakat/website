import type { Address } from "@/features/checkout/schema";
import type { AccountOrder, OrderLine } from "@/features/account/types";

/**
 * Seeded order history for the fixture accounts.
 *
 * Between them these six orders exercise every brief §33 status. Six orders cannot each
 * *currently* sit in nine different states, so the four retail orders rest in the states
 * worth looking at — delivered, out for delivery, cancelled, refunded — and carry the
 * in-flight ones (pending, confirmed, processing, packed, shipped) inside their
 * timelines, which is exactly what the timeline on the order detail page renders.
 *
 * The two bulk orders belong to `b2b@demo.in` and carry the B2B status set from client
 * brief §33 (see docs/client-brief.md): quote requested, quote sent, quote accepted,
 * awaiting payment, approved, processing, shipped, delivered. Between them the two
 * timelines cover all eight.
 *
 * Line totals are the seed catalogue's own prices, so the arithmetic below matches what
 * the shop would charge today: retail packs at their listed price, bulk lines at the
 * resolved tier rate. Totals are derived rather than typed in, so they cannot drift.
 */

const RETAIL_ADDRESS: Address = {
  fullName: "Asha Rao",
  phone: "9876543210",
  email: "b2c@demo.in",
  line1: "12 Residency Road",
  line2: "Near Mayo Hall",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560025",
};

const BUSINESS_ADDRESS: Address = {
  fullName: "Rakesh Anand",
  phone: "9845012345",
  email: "b2b@demo.in",
  line1: "Unit 7, Peenya Industrial Area, Phase II",
  line2: "Goods entrance on the rear road",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560058",
};

/** Flat 5% GST, matching every product in the seed catalogue, and the ₹79 flat shipping. */
function money(items: OrderLine[], shipping: number) {
  const subtotal = items.reduce((sum, i) => sum + (i.total ?? 0), 0);
  const gst = Math.round(subtotal * 0.05);
  // No coupon applies to any seeded order, so the discount is zero everywhere. It is returned
  // rather than omitted because `AccountOrder.discount` is required.
  const discount = 0;
  return { subtotal, discount, gst, shipping, total: subtotal - discount + gst + shipping };
}

const retail = (slug: string, name: string, detail: string, qty: number, unit: number): OrderLine => ({
  slug,
  name,
  detail,
  qty,
  total: unit * qty,
});

const bulk = (slug: string, name: string, kg: number, ratePerKg: number): OrderLine => ({
  slug,
  name,
  detail: `${kg} kg`,
  qty: 1,
  total: kg * ratePerKg,
});

const order1Items = [
  retail("w320-cashews", "W320 Cashews", "500g", 2, 599),
  retail("premium-california-almonds", "Premium California Almonds", "1kg", 1, 999),
];

const order2Items = [
  retail("roasted-makhana", "Roasted Makhana", "250g", 3, 299),
  retail("premium-pistachios", "Premium Pistachios", "250g", 1, 509),
];

const order3Items = [retail("medjool-dates", "Medjool Dates", "500g", 1, 659)];

const order4Items = [
  retail("california-walnuts", "California Walnut Kernels", "500g", 1, 709),
  retail("golden-raisins", "Golden Raisins", "500g", 1, 269),
];

// 25kg lands in the 25–49kg slab (0.85x base), 10kg in the 10–24kg slab (0.9x base).
const order5Items = [
  bulk("w320-cashews", "W320 Cashews", 25, 934),
  bulk("premium-pistachios", "Premium Pistachios", 10, 1529),
];

const order6Items = [
  bulk("premium-california-almonds", "Premium California Almonds", 25, 849),
  bulk("afghani-black-raisins", "Afghani Black Raisins", 25, 552),
];

export const orders: AccountOrder[] = [
  {
    id: "NN-2026-005107",
    email: "b2c@demo.in",
    channel: "retail",
    status: "out-for-delivery",
    placedAt: "2026-08-12T05:20:00.000Z",
    estimatedDelivery: "2026-08-15T12:00:00.000Z",
    timeline: [
      { status: "pending", at: "2026-08-12T05:20:00.000Z" },
      { status: "confirmed", at: "2026-08-12T05:22:00.000Z", note: "Payment received." },
      { status: "processing", at: "2026-08-13T05:00:00.000Z" },
      { status: "packed", at: "2026-08-13T09:40:00.000Z" },
      { status: "shipped", at: "2026-08-14T03:30:00.000Z" },
      {
        status: "out-for-delivery",
        at: "2026-08-15T02:45:00.000Z",
        note: "With the delivery partner for today.",
      },
    ],
    items: order2Items,
    ...money(order2Items, 0),
    address: RETAIL_ADDRESS,
    paymentMethod: "cod",
    // Not collected yet — COD is taken at the door.
    paymentStatus: "pending",
  },
  {
    id: "NN-2026-005042",
    email: "b2b@demo.in",
    channel: "bulk",
    status: "shipped",
    placedAt: "2026-08-08T04:30:00.000Z",
    estimatedDelivery: "2026-08-16T12:00:00.000Z",
    timeline: [
      { status: "quote-requested", at: "2026-08-08T04:30:00.000Z", note: "Purchase order ANS/2026/0412." },
      { status: "quote-sent", at: "2026-08-08T09:00:00.000Z" },
      { status: "quote-accepted", at: "2026-08-09T05:15:00.000Z" },
      { status: "awaiting-payment", at: "2026-08-09T06:00:00.000Z" },
      { status: "approved", at: "2026-08-10T04:20:00.000Z", note: "Payment received against PO." },
      { status: "processing", at: "2026-08-10T05:00:00.000Z", note: "Grading and vacuum packing." },
      {
        status: "shipped",
        at: "2026-08-13T03:45:00.000Z",
        note: "Sent by surface freight. Tracking details emailed.",
      },
    ],
    items: order5Items,
    ...money(order5Items, 0),
    address: BUSINESS_ADDRESS,
    paymentMethod: "cod",
    // Not collected yet — COD is taken on delivery.
    paymentStatus: "pending",
    companyName: "Anand Sweets & Namkeen",
    gstin: "29ABCDE1234F1Z5",
    poNumber: "ANS/2026/0412",
  },
  {
    id: "NN-2026-004977",
    email: "b2c@demo.in",
    channel: "retail",
    status: "cancelled",
    placedAt: "2026-08-05T14:10:00.000Z",
    estimatedDelivery: "2026-08-09T12:00:00.000Z",
    timeline: [
      { status: "pending", at: "2026-08-05T14:10:00.000Z" },
      { status: "confirmed", at: "2026-08-05T14:12:00.000Z" },
      {
        status: "cancelled",
        at: "2026-08-06T04:30:00.000Z",
        note: "Cancelled at your request before dispatch.",
      },
    ],
    items: order3Items,
    ...money(order3Items, 79),
    address: RETAIL_ADDRESS,
    paymentMethod: "cod",
    // Cancelled before dispatch, so nothing was ever collected.
    paymentStatus: "pending",
  },
  {
    id: "NN-2026-004821",
    email: "b2c@demo.in",
    channel: "retail",
    status: "delivered",
    placedAt: "2026-07-28T10:02:00.000Z",
    estimatedDelivery: "2026-08-01T12:00:00.000Z",
    timeline: [
      { status: "pending", at: "2026-07-28T10:02:00.000Z" },
      { status: "confirmed", at: "2026-07-28T10:05:00.000Z", note: "Payment received." },
      { status: "processing", at: "2026-07-29T06:30:00.000Z" },
      { status: "packed", at: "2026-07-29T11:15:00.000Z" },
      { status: "shipped", at: "2026-07-30T04:40:00.000Z" },
      { status: "out-for-delivery", at: "2026-07-31T03:10:00.000Z" },
      { status: "delivered", at: "2026-07-31T08:55:00.000Z", note: "Left with the recipient." },
    ],
    items: order1Items,
    ...money(order1Items, 0),
    address: RETAIL_ADDRESS,
    paymentMethod: "cod",
    paymentStatus: "collected",
  },
  {
    id: "NN-2026-004650",
    email: "b2c@demo.in",
    channel: "retail",
    status: "refunded",
    placedAt: "2026-07-09T08:00:00.000Z",
    estimatedDelivery: "2026-07-13T12:00:00.000Z",
    timeline: [
      { status: "pending", at: "2026-07-09T08:00:00.000Z" },
      { status: "confirmed", at: "2026-07-09T08:02:00.000Z" },
      { status: "processing", at: "2026-07-10T05:15:00.000Z" },
      { status: "packed", at: "2026-07-10T10:20:00.000Z" },
      { status: "shipped", at: "2026-07-11T04:05:00.000Z" },
      { status: "delivered", at: "2026-07-13T07:30:00.000Z" },
      {
        status: "refunded",
        at: "2026-07-18T06:00:00.000Z",
        note: "Returned and refunded to the original payment method.",
      },
    ],
    items: order4Items,
    ...money(order4Items, 79),
    address: RETAIL_ADDRESS,
    paymentMethod: "cod",
    paymentStatus: "refunded",
  },
  {
    id: "NN-2026-004488",
    email: "b2b@demo.in",
    channel: "bulk",
    status: "delivered",
    placedAt: "2026-06-24T05:10:00.000Z",
    estimatedDelivery: "2026-07-02T12:00:00.000Z",
    timeline: [
      { status: "quote-requested", at: "2026-06-24T05:10:00.000Z", note: "Purchase order ANS/2026/0388." },
      { status: "quote-sent", at: "2026-06-24T10:30:00.000Z" },
      { status: "quote-accepted", at: "2026-06-25T06:15:00.000Z" },
      { status: "awaiting-payment", at: "2026-06-25T07:00:00.000Z" },
      { status: "approved", at: "2026-06-26T04:10:00.000Z", note: "Payment received against PO." },
      { status: "processing", at: "2026-06-26T04:50:00.000Z" },
      { status: "shipped", at: "2026-06-30T03:20:00.000Z" },
      {
        status: "delivered",
        at: "2026-07-03T04:15:00.000Z",
        note: "GST invoice emailed to accounts.",
      },
    ],
    items: order6Items,
    ...money(order6Items, 0),
    address: BUSINESS_ADDRESS,
    paymentMethod: "cod",
    paymentStatus: "collected",
    companyName: "Anand Sweets & Namkeen",
    gstin: "29ABCDE1234F1Z5",
    poNumber: "ANS/2026/0388",
  },
];
