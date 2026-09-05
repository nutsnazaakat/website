import { BadgeCheck, FileText, PackageCheck, ShieldCheck, Truck, Warehouse } from "lucide-react";
import { settings } from "@/config/settings";

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
    icon: BadgeCheck,
    title: "Quality Checked",
    body: "Every intake lot is checked for colour, moisture, breakage and smell before it is accepted.",
  },
  {
    icon: PackageCheck,
    title: "Hygienically Packed",
    body: "Retail packs are filled and sealed after your order is placed, with a batch code on the pouch.",
  },
  {
    icon: ShieldCheck,
    title: "Secure Payments",
    body: "Card, UPI and netbanking are handled by the payment gateway. We never see your card details.",
  },
  {
    icon: Truck,
    title: "Pan-India Delivery",
    body: "Dispatched within a working day and tracked to the door across the country.",
  },
  {
    icon: Warehouse,
    title: "Bulk Supply",
    body: "Per-kilogram slab pricing from 1 kg upwards, with samples before a large consignment.",
  },
  {
    icon: FileText,
    title: "GST Invoices",
    body: "Compliant invoices with HSN codes, so a registered business can claim input credit.",
  },
] as const;

export function TrustSection({ heading = "Why buy from us" }: { heading?: string }) {
  return (
    <section aria-label="Trust and assurance" className="container-page py-16">
      <h2 className="font-display text-3xl">{heading}</h2>
      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {signals.map((s) => (
          <li key={s.title} className="border-border bg-card shadow-soft rounded-2xl border p-6">
            <s.icon className="text-leaf size-5" aria-hidden="true" />
            <p className="mt-4 font-semibold">{s.title}</p>
            <p className="text-muted-foreground mt-1.5 text-sm">{s.body}</p>
          </li>
        ))}
      </ul>

      {settings.certifications.length > 0 && (
        <ul
          aria-label="Certifications"
          className="border-border mt-6 flex flex-wrap gap-2 border-t pt-6"
        >
          {settings.certifications.map((c) => (
            <li
              key={c}
              className="bg-sand flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm"
            >
              <ShieldCheck className="text-leaf size-4" aria-hidden="true" />
              {c}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
