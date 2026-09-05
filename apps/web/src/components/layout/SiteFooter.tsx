import { Link, linkOptions } from "@tanstack/react-router";
import { settings } from "@/config/settings";

const cols = [
  {
    title: "Shop",
    links: [
      { label: "All Products", opts: linkOptions({ to: "/shop" }) },
      {
        label: "Almonds",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "almonds" } }),
      },
      {
        label: "Cashews",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "cashews" } }),
      },
      {
        label: "Pistachios",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "pistachios" } }),
      },
      {
        label: "Walnuts",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "walnuts" } }),
      },
      {
        label: "Raisins",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "raisins" } }),
      },
      {
        label: "Makhana",
        opts: linkOptions({ to: "/category/$slug", params: { slug: "makhana" } }),
      },
      { label: "Combos", opts: linkOptions({ to: "/combos" }) },
    ],
  },
  {
    title: "Business",
    links: [
      { label: "Bulk Orders", opts: linkOptions({ to: "/bulk-orders" }) },
      { label: "Wholesale Pricing", opts: linkOptions({ to: "/bulk-orders" }) },
      { label: "Corporate Gifting", opts: linkOptions({ to: "/gifting" }) },
      { label: "Become a Partner", opts: linkOptions({ to: "/business" }) },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Contact", opts: linkOptions({ to: "/contact" }) },
      { label: "Shipping", opts: linkOptions({ to: "/shipping" }) },
      { label: "Returns", opts: linkOptions({ to: "/returns" }) },
      { label: "FAQs", opts: linkOptions({ to: "/faq" }) },
      { label: "Track Order", opts: linkOptions({ to: "/account/orders" }) },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", opts: linkOptions({ to: "/about" }) },
      { label: "Quality", opts: linkOptions({ to: "/quality" }) },
      { label: "Blog", opts: linkOptions({ to: "/blog" }) },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-border bg-sand mt-24 border-t">
      <div className="container-page grid gap-10 py-14 md:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div>
          <p className="font-display text-2xl">Nuts &amp; Nazaakat</p>
          <p className="text-muted-foreground mt-3 max-w-xs text-sm">
            Premium dry fruits for everyday kitchens and growing food businesses. Small packs for
            home. Bulk supply for business.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.18em] uppercase">
              {c.title}
            </p>
            <ul className="mt-4 space-y-2 text-sm">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link
                    {...l.opts}
                    className="text-foreground/80 hover:text-foreground transition-colors"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-border/70 border-t">
        <div className="container-page text-muted-foreground flex flex-col gap-2 py-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>
            {settings.gstin || settings.fssaiLicence
              ? [
                  settings.gstin && `GSTIN ${settings.gstin}`,
                  settings.fssaiLicence && `FSSAI ${settings.fssaiLicence}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `© ${new Date().getFullYear()} ${settings.brandName}`}
          </p>
          <p className="flex gap-3">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/returns">Refund Policy</Link>
            <Link to="/shipping">Shipping Policy</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}
