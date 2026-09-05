import type {
  AdminDashboard,
  AdminOrder,
  AdminOrderSummary,
  AuthUser,
  Paginated,
} from "@/contract";

/**
 * A stand-in for the API, shaped from responses **measured against the running backend** on
 * 2026-08-27 rather than invented.
 *
 * That distinction is the point. A fixture written from the type alone would happily carry
 * `total: 102085` and every assertion about money would pass while the screen was wrong by a
 * factor of a hundred; these figures are the ones the service actually returned
 * (`total: 1020.85`, `totalSales: 83492.55`), so a test that passes here means the same thing the
 * live check in plan 9.6a's task 6 means.
 */

export const ADMIN_USER: AuthUser = {
  id: "aa3d37af-2e93-4564-80e4-726217fe8519",
  name: "Nazaakat Admin",
  email: "admin@demo.in",
  phone: "9811100011",
  role: "admin",
  createdAt: "2025-01-09T04:00:00.000Z",
};

export const B2C_USER: AuthUser = {
  id: "420762ba-9b8a-4235-a8cf-f1c3e2868f06",
  name: "Asha Rao",
  email: "b2c@demo.in",
  phone: "9876543210",
  role: "b2c",
  createdAt: "2025-01-09T04:00:00.000Z",
};

export const DASHBOARD: AdminDashboard = {
  cards: {
    totalSales: 83492.55,
    b2cSales: 6144.3,
    b2bSales: 77348.25,
    orders: 11,
    pendingOrders: 4,
    pendingRfqs: 2,
    customers: 2,
    b2bCustomers: 1,
    lowStock: 0,
  },
  charts: {
    // Sparse on purpose: the real service returns only days that had orders.
    salesOverTime: [
      { date: "2026-08-08", sales: 40572, orders: 1 },
      { date: "2026-08-12", sales: 1476.3, orders: 1 },
      { date: "2026-08-21", sales: 2361.15, orders: 4 },
    ],
    channelSplit: [
      { channel: "retail", sales: 6144.3, orders: 6 },
      { channel: "bulk", sales: 77348.25, orders: 2 },
    ],
    topProducts: [
      {
        slug: "premium-california-almonds",
        name: "Premium California Almonds",
        unitsSold: 5,
        sales: 23371,
      },
      { slug: "roasted-makhana", name: "Roasted Makhana", unitsSold: 3, sales: 897 },
    ],
    topCategories: [{ slug: "nuts", name: "Nuts", unitsSold: 10, sales: 48000 }],
  },
};

export const ORDER_SUMMARY: AdminOrderSummary = {
  id: "NN-2026-005107",
  customer: {
    userId: "420762ba-9b8a-4235-a8cf-f1c3e2868f06",
    name: "Asha Rao",
    email: "b2c@demo.in",
    phone: "9876543210",
    businessId: null,
    companyName: null,
  },
  channel: "retail",
  status: "out-for-delivery",
  total: 1020.85,
  paymentMethod: "cod",
  paymentStatus: "pending",
  placedAt: "2026-08-21T07:44:13.405Z",
};

export const BULK_SUMMARY: AdminOrderSummary = {
  id: "NN-2026-005042",
  customer: {
    userId: "b-1",
    name: "Rakesh Anand",
    email: "b2b@demo.in",
    phone: "9845012345",
    businessId: "biz-1",
    companyName: "Anand Sweets & Namkeen",
  },
  channel: "bulk",
  status: "shipped",
  total: 40572,
  paymentMethod: "cod",
  paymentStatus: "pending",
  placedAt: "2026-08-08T07:44:13.405Z",
};

export const ORDER_DETAIL: AdminOrder = {
  id: "NN-2026-005107",
  email: "b2c@demo.in",
  channel: "retail",
  status: "out-for-delivery",
  placedAt: "2026-08-21T07:44:13.405Z",
  estimatedDelivery: "2026-08-25T00:00:00.000Z",
  timeline: [
    { status: "pending", at: "2026-08-21T07:44:13.405Z" },
    { status: "out-for-delivery", at: "2026-08-23T07:44:13.405Z", note: "With the rider" },
  ],
  items: [
    {
      slug: "premium-california-almonds",
      name: "Premium California Almonds",
      detail: "500 g",
      qty: 2,
      total: 898,
    },
    { slug: "roasted-makhana", name: "Roasted Makhana", detail: "250 g", qty: 1, total: 299 },
  ],
  subtotal: 1197,
  discount: 0,
  gst: 59.85,
  shipping: 0,
  total: 1020.85,
  address: {
    fullName: "Asha Rao",
    phone: "9876543210",
    email: "b2c@demo.in",
    line1: "12 Brigade Road",
    city: "Bengaluru",
    state: "Karnataka",
    pincode: "560001",
  },
  paymentMethod: "cod",
  paymentStatus: "pending",
  customer: ORDER_SUMMARY.customer,
  paymentCollectedAt: null,
  paymentReference: null,
  shipments: [],
};

export function page<T>(items: T[], total = items.length): Paginated<T> {
  return { items, total, page: 1, limit: 24 };
}

export interface Recorded {
  url: string;
  method: string;
  body?: string;
}

/**
 * Installs a `fetch` that answers from a routing table, and records what was asked for.
 *
 * A handler returning `undefined` falls through to a 404, so a test that forgets to stub something
 * fails loudly rather than hanging on a promise that never settles.
 */
export function installApi(handlers: Record<string, (call: Recorded) => unknown>): {
  calls: Recorded[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Recorded = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    };
    calls.push(call);

    const path = url.replace("/api/v1", "").split("?")[0] ?? "";
    const key = `${call.method} ${path}`;
    const handler = handlers[key];

    if (handler === undefined) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ success: false, statusCode: 404, message: `No stub for ${key}` }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    const result = handler(call);
    if (result instanceof Response) return Promise.resolve(result);
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** The real error envelope, so `ApiRequestError` is built from what the service actually emits. */
export function apiError(
  status: number,
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      statusCode: status,
      timestamp: "2026-08-27T00:00:00.000Z",
      path: "/api/v1/admin/orders",
      method: "POST",
      message,
      ...(code === undefined ? {} : { code }),
      ...(details === undefined ? {} : { details }),
      errorId: "err_test",
      requestId: "req_test",
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** `JwtAuthGuard` answers a bare `UnauthorizedException` — a message, and no `code`. */
export const unauthorized = () => apiError(401, "Unauthorized");
