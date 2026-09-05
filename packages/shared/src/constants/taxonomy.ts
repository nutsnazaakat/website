/** Brief §28. The six editorial categories the blog is organised into. */
export const BLOG_CATEGORIES = [
  'Dry Fruit Guides',
  'Buying Guides',
  'Recipes',
  'Storage Tips',
  'B2B',
  'Nutrition Education',
] as const;

export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

/** The reasons the contact form routes on. Kept short so the sales desk can triage. */
export const CONTACT_TOPICS = [
  'An order I have placed',
  'Shipping or delivery',
  'Returns or a damaged item',
  'Bulk and wholesale pricing',
  'Corporate gifting',
  'Something else',
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/**
 * Brief §14, verbatim from `frontend/src/features/rfq/schema.ts`.
 *
 * These are the exact strings the RFQ and business-profile selects already submit and that
 * the seeded RFQ fixtures already contain. Brief §14 words its list differently ("Retailers",
 * "Hotels / HORECA", "Food Manufacturers", "Resellers"); the frontend's wording wins, because
 * changing it would invalidate stored RFQ rows for no user-visible gain.
 */
export const BUSINESS_TYPES = [
  'Retail store',
  'Kirana / general store',
  'Sweet shop',
  'Bakery',
  'Café',
  'Restaurant or hotel',
  'Cloud kitchen',
  'Caterer',
  'Corporate gifting',
  'Distributor',
  'Health food brand',
  'Other',
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Brief §16/§31. The price band a business buys at, and **not** the same question as
 * `BUSINESS_TYPES` above.
 *
 * `businessType` is twelve strings a customer picks for themselves at registration — "Distributor" is
 * one of them. A segment is a commercial decision the sales desk makes, so it is admin-set and starts
 * at `DEFAULT` for everybody. Deriving one from the other would let a customer choose their own price
 * band by ticking a box on a form.
 */
export const CUSTOMER_SEGMENTS = ['default', 'retailer', 'distributor', 'horeca'] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

/** Brief §17 packaging preference, verbatim from `features/rfq/schema.ts`. */
export const PACKAGING_OPTIONS = [
  'Bulk sacks (25 kg)',
  'Vacuum packs (5 kg)',
  'Retail-ready pouches',
  'Custom / own branding',
  'No preference',
] as const;

export type PackagingOption = (typeof PACKAGING_OPTIONS)[number];

/** Brief §17 expected frequency, verbatim from `features/rfq/schema.ts`. */
export const ORDER_FREQUENCIES = [
  'One-time',
  'Weekly',
  'Fortnightly',
  'Monthly',
  'Quarterly',
] as const;

export type OrderFrequency = (typeof ORDER_FREQUENCIES)[number];

/** Brief §24 gifting occasions, verbatim from `features/gifting/schema.ts`. */
export const GIFTING_OCCASIONS = [
  'Diwali',
  'New Year',
  'Employee onboarding',
  'Client appreciation',
  'Wedding',
  'Conference or event',
  'Other',
] as const;

export type GiftingOccasion = (typeof GIFTING_OCCASIONS)[number];

/** Support ticket lifecycle. Spec §11. */
export const SUPPORT_TICKET_STATUSES = ['new', 'open', 'waiting', 'resolved', 'closed'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/**
 * Brief §34. RFQ pipeline as the sales desk works it, and the union `ck_rfqs_status` enforces at
 * the database. `frontend/src/features/rfq/types.ts` re-exports this rather than declaring its
 * own — it used to carry an unwired four-state guess ("new" | "quoted" | "accepted" | "closed").
 * Only `new` overlapped: `quoted`, `accepted` and `closed` are values the constraint refuses, and
 * the six real values besides `new` — `contacted`, `quote-sent`, `negotiation`, `approved`,
 * `rejected`, `converted` — had no label at all.
 */
export const RFQ_STATUSES = [
  'new',
  'contacted',
  'quote-sent',
  'negotiation',
  'approved',
  'rejected',
  'converted',
] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];
