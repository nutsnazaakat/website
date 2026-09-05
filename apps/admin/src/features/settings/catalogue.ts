/**
 * What each setting is for, in the operator's language, and which group it belongs in.
 *
 * A settings screen that renders `fssaiLicence` as "fssaiLicence" is a screen only its author can
 * use. These labels are **additive**: a key with no entry here still renders, under its own name,
 * in "Other" — so a setting added by a later seed appears immediately rather than disappearing
 * until somebody remembers to describe it. That is the opposite of a whitelist, and deliberately.
 *
 * The `hint` on the empty-by-design keys is the sentence brief §26 and §37 require somebody to
 * read: those fields are blank because inventing a value is forbidden, and the storefront renders
 * nothing for them until a real one is typed.
 */
export interface SettingMeta {
  label: string;
  hint?: string;
}

export const SETTING_GROUPS: readonly {
  heading: string;
  blurb: string;
  keys: readonly string[];
}[] = [
  {
    heading: "Contact the storefront shows",
    blurb:
      "Brief §37: the WhatsApp CTAs and the footer read these. They seed empty on purpose — do not hardcode a fake number — so the storefront renders nothing until a real value is here.",
    keys: ["whatsappNumber", "supportEmail", "supportPhone", "addressLines", "social"],
  },
  {
    heading: "Compliance and trust",
    blurb:
      "Brief §26: certification information must be editable from Admin. Empty means the trust section shows no claim, which is correct until the real licence numbers are typed in.",
    keys: ["gstin", "fssaiLicence", "certifications"],
  },
  {
    heading: "Brand",
    blurb: "The name and line the storefront prints.",
    keys: ["brandName", "tagline"],
  },
  {
    heading: "Commerce",
    blurb: "Thresholds and payment methods. These have real defaults and are not empty.",
    keys: [
      "freeShippingThreshold",
      "flatShippingRate",
      "bulkPromptThresholdGrams",
      "codEnabled",
      "onlinePaymentEnabled",
    ],
  },
  {
    heading: "Operations",
    blurb:
      "Not shown to anybody outside this console — but this one changes what the dashboard says.",
    keys: ["business.timezone"],
  },
];

export const SETTING_META: Readonly<Record<string, SettingMeta>> = {
  whatsappNumber: {
    label: "WhatsApp number",
    hint: "Brief §37's “Talk to Bulk Sales” and “Ask About Bulk Pricing” CTAs link to this. Country code and number, no plus — 919876543210. Empty means no WhatsApp CTA renders at all.",
  },
  supportEmail: {
    label: "Support email",
    hint: "Printed in the footer and on the contact page. Empty means neither shows an address.",
  },
  supportPhone: {
    label: "Support phone",
    hint: "Empty means the storefront shows no phone number. That is better than a number nobody answers.",
  },
  addressLines: {
    label: "Postal address",
    hint: "One line per row. Empty means the footer prints no address.",
  },
  social: {
    label: "Social links",
    hint: "One URL per row. Empty means no social icons.",
  },
  gstin: {
    label: "GSTIN",
    hint: "Brief §26. Printed on invoices and in the footer. 15 characters. Empty means no GST claim is made anywhere.",
  },
  fssaiLicence: {
    label: "FSSAI licence number",
    hint: "Brief §26. A food business must display it — and a placeholder would be exactly the unsupported claim the brief rules out, so it seeds empty.",
  },
  certifications: {
    label: "Certifications",
    hint: "One per row, e.g. “FSSAI”, “ISO 22000”. Brief §26 requires these to be editable here and never hardcoded. Empty renders nothing in the trust section.",
  },
  brandName: { label: "Brand name" },
  tagline: { label: "Tagline" },
  freeShippingThreshold: {
    label: "Free shipping above (₹)",
    hint: "Rupees. The storefront's “₹— away from free delivery” message reads this.",
  },
  flatShippingRate: {
    label: "Flat shipping rate (₹)",
    hint: "Rupees, charged below the free-shipping threshold.",
  },
  bulkPromptThresholdGrams: {
    label: "Bulk prompt threshold (grams)",
    hint: "The basket weight at which the storefront suggests a bulk enquiry instead.",
  },
  codEnabled: {
    label: "Cash on delivery",
    hint: "Spec §10.4. COD is the only payment method until online payment is deliberately switched on.",
  },
  onlinePaymentEnabled: {
    label: "Online payment",
    hint: "Off until a gateway is actually integrated. Switching it on does not integrate one.",
  },
  "business.timezone": {
    label: "Business timezone",
    hint: "An IANA name — Asia/Kolkata. This decides what “today” means for every dated admin figure: the dashboard's sales bars and the order list's date filter both group and bound days by it. Changing it changes what the dashboard reports for the same orders.",
  },
};

/** Keys with a group, so anything else can be collected into "Other" rather than dropped. */
export const GROUPED_KEYS: ReadonlySet<string> = new Set(
  SETTING_GROUPS.flatMap((group) => group.keys),
);
