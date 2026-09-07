import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/common/LegalPage";
import { useSiteSettings } from "@/config/useSiteSettings";

export const Route = createFileRoute("/terms")({ component: Terms });

function Terms() {
  const settings = useSiteSettings();
  return (
    <LegalPage
      title="Terms of Service"
      updated="15 August 2026"
      intro="The terms on which this site is offered and orders are accepted."
      metaDescription="Terms covering account use, pricing and availability, how an order is accepted, bulk quotations, product information, liability and governing law."
      sections={[
        {
          heading: "Using this site",
          body: [
            `By browsing or ordering from ${settings.brandName} you accept these terms. If you do not accept them, please do not use the site.`,
            "You agree not to interfere with the site's operation, attempt to access accounts that are not yours, or scrape the catalogue for commercial use without written permission.",
          ],
        },
        {
          heading: "Accounts",
          body: [
            "You are responsible for keeping your sign-in details private and for activity that takes place under your account. Tell us immediately if you believe someone else has access to it.",
            "One account covers both retail and business buying. Enabling business buying requires accurate company details, and supplying a GSTIN that is not yours is grounds for closing the account.",
          ],
        },
        {
          heading: "Prices and availability",
          body: [
            "Prices are shown in Indian rupees. Retail prices include applicable taxes; bulk per-kilogram rates are quoted before GST and the tax is added at checkout.",
            "Prices and stock change. We may correct a price or withdraw a product at any time before your order is accepted. Where a price error is obvious and material, we will contact you rather than silently cancel.",
          ],
        },
        {
          heading: "Orders and acceptance",
          body: [
            "Placing an order is an offer to buy. A contract forms only when we confirm the order, and we may decline an order — for example where stock has run out, the delivery address is not serviceable, or a pricing error has occurred.",
            "Where an order is declined after payment, the payment is refunded in full.",
          ],
        },
        {
          heading: "Bulk quotations",
          body: [
            "A quotation is valid for the period stated on it and is subject to stock and harvest conditions at the time of acceptance. Rates above the published slabs depend on grade, quantity and delivery schedule.",
            "Custom packing, branding and labelling are quoted separately and, once produced to your specification, cannot be cancelled.",
          ],
        },
        {
          heading: "Product information",
          body: [
            "We describe variety, grade, origin and specification as accurately as we can. These are agricultural products, so natural variation between harvests and lots is normal and is not a defect.",
            "Photographs on this site are placeholders and are not intended to represent the exact appearance of a specific consignment.",
            "Nothing on this site is medical or dietary advice.",
          ],
        },
        {
          heading: "Liability",
          body: [
            "Where we are at fault, our liability is limited to the value of the affected order. Nothing in these terms limits liability where the law does not allow it to be limited.",
            "We are not liable for delays caused by couriers, weather or events outside our reasonable control, though we will always help you chase them.",
          ],
        },
        {
          heading: "Intellectual property",
          body: [
            "The text, layout and branding of this site belong to us. You may not reproduce them commercially without written permission.",
          ],
        },
        {
          heading: "Governing law",
          body: [
            "These terms are governed by Indian law, and the courts of India have jurisdiction over any dispute arising from them.",
          ],
        },
      ]}
    />
  );
}
