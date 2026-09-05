/**
 * Values an admin will own in Phase 3. Nothing here may be hardcoded in a component.
 * Certification fields are intentionally empty — the brief forbids unsupported claims,
 * so badges render only once real registration numbers are configured.
 */
export interface SiteSettings {
  brandName: string;
  tagline: string;
  whatsappNumber: string;
  supportEmail: string;
  supportPhone: string;
  freeShippingThreshold: number;
  bulkPromptThresholdGrams: number;
  /**
   * Which payment methods checkout may offer. Both mirror a `settings` row the database already
   * holds — `codEnabled: true`, `onlinePaymentEnabled: false` (`settings.seed.ts`) — and Milestone 8
   * swaps this read for a real `GET /settings/public`.
   *
   * They live here rather than being fetched because **nothing exposes them**: `Setting.isPublic` is
   * read by no route in `backend/src`, so there is no endpoint to call and building one is Milestone
   * 8's work, not a form's. Until then the server's `422 PAYMENT_METHOD_UNAVAILABLE` is the actual
   * enforcement and these two flags are merchandising: they stop `CheckoutForm` offering a door that
   * was never open.
   *
   * Typed `boolean`, never `true`/`false` literals. `settings` is annotated `: SiteSettings`, so the
   * declared type is what a component narrows against — and a literal type would make the
   * both-disabled branch unreachable code that no test could reach.
   */
  codEnabled: boolean;
  onlinePaymentEnabled: boolean;
  gstin: string;
  fssaiLicence: string;
  certifications: string[];
  social: { label: string; url: string }[];
  addressLines: string[];
}

export const settings: SiteSettings = {
  brandName: "Nuts & Nazaakat",
  tagline: "Small packs for home. Bulk supply for business.",
  whatsappNumber: "",
  supportEmail: "",
  supportPhone: "",
  freeShippingThreshold: 999,
  bulkPromptThresholdGrams: 5000,
  codEnabled: true,
  onlinePaymentEnabled: false,
  gstin: "",
  fssaiLicence: "",
  certifications: [],
  social: [],
  addressLines: [],
};
