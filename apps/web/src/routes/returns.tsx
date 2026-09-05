import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/common/LegalPage";

export const Route = createFileRoute("/returns")({ component: Returns });

function Returns() {
  return (
    <LegalPage
      title="Returns & Refunds"
      updated="15 August 2026"
      intro="What can be returned, what cannot, how long you have and how a refund is issued."
      metaDescription="The seven-day window for damaged, incorrect or short-supplied items, what cannot be returned on food-safety grounds, and how refunds are processed."
      tabs="returns"
      sections={[
        {
          heading: "What we replace or refund",
          body: [
            "Tell us within seven days of delivery and we will replace or refund an item that is:",
            [
              "Damaged in transit",
              "The wrong product, grade or pack size",
              "Short-supplied against the order",
              "Materially different from the specification on the product page",
            ],
            "Send the order ID and, where packaging is involved, a photograph of the outer carton and the contents. This is usually enough to resolve it without sending anything back.",
          ],
        },
        {
          heading: "What we cannot take back",
          body: [
            "These are food products, and once a sealed pack has been opened we cannot resell it or verify how it has been stored. So we cannot accept returns of:",
            [
              "Opened packs where the product is as described",
              "Items reported more than seven days after delivery",
              "Products stored outside the conditions on the pack",
              "Custom or branded gifting orders produced to your specification",
            ],
            "This is a food-safety position rather than a commercial one. If you believe a sealed pack was not as described, tell us — that is a different case and is covered above.",
          ],
        },
        {
          heading: "Bulk consignments",
          body: [
            "Bulk consignments should be inspected on receipt. Raise any quality issue within seven days of delivery, quoting the batch code on the packing, so we can trace it to the consignment.",
            "We ship 1 kg samples of any grade precisely so that specification disagreements are settled before a large consignment ships rather than after.",
          ],
        },
        {
          heading: "Cancellations",
          body: [
            "An order can be cancelled at no cost until it moves to Packed. Once a pack has been filled and sealed against your order it has left our hands and the returns process applies instead.",
            "Quote-based bulk orders can be cancelled before dispatch unless the consignment involved custom packing or branding already produced.",
          ],
        },
        {
          heading: "How refunds are issued",
          body: [
            "Approved refunds go back to the original payment method. Bank processing usually takes five to seven working days after we issue the refund, which is outside our control.",
            "Where a replacement is preferred we will ship it as soon as the claim is approved, without waiting for anything to be returned.",
          ],
        },
        {
          heading: "How to raise a claim",
          body: [
            "Use the contact form with the order ID, what is wrong and any photographs. Claims are acknowledged within one working day and resolved as quickly as the facts allow.",
          ],
        },
      ]}
    />
  );
}
