import type { User } from "@/features/auth/types";

/**
 * The three fixture accounts spec §10 seeds. Phase 1 accepts any password for them — the
 * sign-in screen says so out loud rather than leaving a reviewer guessing.
 *
 * `b2b@demo.in` carries a populated company profile, which is what gives one account
 * bulk access; there is no separate B2B login.
 */
export const users: User[] = [
  {
    id: "usr-b2c-001",
    name: "Asha Rao",
    email: "b2c@demo.in",
    phone: "9876543210",
    role: "b2c",
    createdAt: "2025-11-04T09:12:00.000Z",
  },
  {
    id: "usr-b2b-001",
    name: "Rakesh Anand",
    email: "b2b@demo.in",
    phone: "9845012345",
    role: "b2b",
    company: {
      companyName: "Anand Sweets & Namkeen",
      contactPerson: "Rakesh Anand",
      businessType: "Sweet shop",
      gstin: "29ABCDE1234F1Z5",
    },
    createdAt: "2025-06-18T05:40:00.000Z",
  },
  {
    id: "usr-admin-001",
    name: "Nazaakat Admin",
    email: "admin@demo.in",
    phone: "9811100011",
    role: "admin",
    createdAt: "2025-01-09T04:00:00.000Z",
  },
];
