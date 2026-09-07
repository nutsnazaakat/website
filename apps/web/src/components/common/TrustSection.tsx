import { useSiteSettings } from "@/config/useSiteSettings";

/**
 * Brief §26. The six trust signals, plus the certification strip.
 *
 * Every item here describes something the site actually does — grading on intake, sealed
 * packing, a payment step, pan-India dispatch, per-kg supply and GST invoicing. None of
 * them asserts an accreditation.
 *
 * Certifications are a separate matter and the brief is explicit: *"Certification
 * information must be editable from Admin"* and *"Do not claim certifications unless
 * configured by Admin."* So the badge strip reads `settings.certifications` and renders
 * nothing at all while that array is empty. Hardcoding a licence number here — even a
 * plausible-looking placeholder — is the failure mode this component exists to prevent.
 */
const signals = [
  {
    title: "Quality Checked",
    body: "Every intake lot is checked for colour, moisture, breakage and smell before it is accepted.",
  },
  {
    title: "Hygienically Packed",
    body: "Retail packs are filled and sealed after your order is placed, with a batch code on the pouch.",
  },
  {
    title: "Secure Payments",
    body: "Card, UPI and netbanking are handled by the payment gateway. We never see your card details.",
  },
  {
    title: "Pan-India Delivery",
    body: "Dispatched within a working day and tracked to the door across the country.",
  },
  {
    title: "Bulk Supply",
    body: "Per-kilogram slab pricing from 1 kg upwards, with samples before a large consignment.",
  },
  {
    title: "GST Invoices",
    body: "Compliant invoices with HSN codes, so a registered business can claim input credit.",
  },
] as const;

export function TrustSection({ heading = "Why buy from us" }: { heading?: string }) {
  const settings = useSiteSettings();
  return (
    <section aria-label="Trust and assurance" className="container-page py-16">
      <h2 className="heading-shout">{heading}</h2>
      <ul className="hairline-grid mt-6 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
        {signals.map((s, i) => (
          <li key={s.title} className="bg-card px-5 py-6">
            <span className="numeral">0{i + 1}</span>
            <p className="mt-3 font-bold">{s.title}</p>
            <p className="text-muted-foreground mt-1.5 text-[13px] leading-[1.55]">{s.body}</p>
          </li>
        ))}
      </ul>

      {settings.certifications.length > 0 && (
        <ul
          aria-label="Certifications"
          className="border-border mt-6 flex flex-wrap gap-2 border-t pt-6"
        >
          {settings.certifications.map((c) => (
            <li key={c} className="bg-sand px-3 py-1.5 text-sm">
              {c}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
