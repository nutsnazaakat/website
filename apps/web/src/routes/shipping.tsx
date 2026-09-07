import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/common/LegalPage";
import { useSiteSettings } from "@/config/useSiteSettings";
import { inr } from "@/lib/format";

export const Route = createFileRoute("/shipping")({ component: Shipping });

function Shipping() {
  const settings = useSiteSettings();
  return (
    <LegalPage
      title="Shipping Policy"
      updated="15 August 2026"
      intro="How orders are packed, when they leave us, what delivery costs and what happens when something goes wrong in transit."
      metaDescription="Dispatch timelines, delivery estimates, shipping charges, the free-shipping threshold and what to do if a consignment is damaged or delayed."
      tabs="shipping"
      sections={[
        {
          heading: "Dispatch",
          body: [
            "Retail orders are packed and handed to the courier within one working day of payment being confirmed. Orders placed on a Sunday or a public holiday are dispatched on the next working day.",
            "Bulk consignments are dispatched according to the schedule confirmed on the quotation, because packing format and volume affect how long the consignment takes to prepare.",
          ],
        },
        {
          heading: "Delivery times",
          body: [
            "Delivery generally takes two to six working days from dispatch, depending on the destination pincode. The pincode checker on each product page gives an estimate before you order.",
            "These are estimates, not guarantees. Weather, courier backlogs and regional disruptions can extend them, and we will tell you if we know your consignment is affected.",
          ],
        },
        {
          heading: "Shipping charges",
          body: [
            `Retail orders above ${inr(settings.freeShippingThreshold)} ship free. Below that a flat shipping charge applies and is shown in the cart summary before you pay.`,
            "Bulk consignment freight depends on weight, packing format and destination, and is quoted separately rather than charged at a flat rate.",
          ],
        },
        {
          heading: "Serviceable areas",
          body: [
            "We deliver to most pincodes in India but not all. The pincode checker tells you whether we serve your area before you add anything to the cart.",
            "If your pincode is not currently serviceable, it is worth checking again — coverage changes as courier partnerships expand.",
          ],
        },
        {
          heading: "Packing",
          body: [
            "Retail packs are sealed pouches inside a protective outer carton.",
            "Bulk consignments are packed in the format agreed on the order:",
            [
              "25 kg bulk sacks",
              "5 kg vacuum packs",
              "Retail-ready pouches",
              "Your own branded packaging, where arranged in advance",
            ],
          ],
        },
        {
          heading: "Damage, delay and non-delivery",
          body: [
            "If a consignment arrives damaged, tell us within seven days of delivery with the order ID and photographs of the outer packaging and the contents. We replace damaged goods free of charge.",
            "If tracking has not moved for more than five working days, contact us and we will chase the courier on your behalf rather than asking you to.",
            "If a delivery fails because nobody was available at the address, the courier will normally reattempt. After repeated failures the consignment returns to us and we contact you to arrange redelivery.",
          ],
        },
        {
          heading: "Addresses and contact details",
          body: [
            "Please check the delivery address and mobile number before placing an order. We can change an address until the order moves to Packed; after that the consignment is already labelled.",
          ],
        },
      ]}
    />
  );
}
