import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/common/LegalPage";

export const Route = createFileRoute("/privacy")({ component: Privacy });

function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="15 August 2026"
      intro="What personal information this site collects, why it is collected, who it is shared with and what you can ask us to do with it."
      metaDescription="The personal information collected when you shop or raise a quote request, how it is used, who it is shared with, how long it is kept and your rights over it."
      sections={[
        {
          heading: "Information we collect",
          body: [
            "We collect only what an order or an enquiry actually requires:",
            [
              "Contact details — name, email address and mobile number",
              "Delivery and billing addresses",
              "Business details where you buy as a business — company name, GSTIN and business type",
              "Order, quotation and enquiry history",
              "Reviews you submit, including the display name you choose",
              "Technical information your browser sends, such as device type and pages visited",
            ],
            "We do not collect or store card numbers. Payment details are handled by the payment gateway and never reach our systems.",
          ],
        },
        {
          heading: "Why we use it",
          body: [
            "To take payment, pack the right goods, deliver them to the right address, issue a compliant invoice, answer your questions, and price a quotation. Where you have asked for it, to send order updates.",
            "We do not sell personal information to anyone.",
          ],
        },
        {
          heading: "Who we share it with",
          body: [
            "Only the parties needed to complete what you asked for:",
            [
              "Courier partners, who receive the delivery address and contact number",
              "The payment gateway, which processes the transaction",
              "Accounting and tax filings, as required by law",
            ],
            "Each receives the minimum needed to do its part, and nothing beyond it.",
          ],
        },
        {
          heading: "Cookies and local storage",
          body: [
            "This site stores your cart and, if you sign in, your session in your browser's local storage so they survive a page reload. Clearing your browser storage clears both.",
            "Any analytics or advertising cookies will be described here, with a consent mechanism, before they are introduced.",
          ],
        },
        {
          heading: "How long we keep it",
          body: [
            "Order and invoice records are kept for as long as tax and accounting law requires. Enquiry and quotation records are kept while the relationship is active. Account details are kept until you ask us to delete them.",
          ],
        },
        {
          heading: "Your rights",
          body: [
            "You can ask us to show you the personal information we hold about you, correct anything inaccurate, or delete it where no legal obligation requires us to keep it. You can also ask us to stop sending marketing messages at any time.",
            "Use the contact form to make any of these requests. We respond within a reasonable period.",
          ],
        },
        {
          heading: "Security",
          body: [
            "Access to customer data is limited to the people who need it to fulfil orders and answer enquiries. No system is perfectly secure, and we do not claim otherwise — but we do not retain what we do not need, which is the most effective protection available.",
          ],
        },
        {
          heading: "Changes to this policy",
          body: [
            "When this policy changes materially, the updated date at the top of the page changes with it. Continuing to use the site after a change means accepting the revised policy.",
          ],
        },
      ]}
    />
  );
}
