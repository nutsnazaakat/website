import { Link, linkOptions } from "@tanstack/react-router";
import { BrandMark } from "@/components/common/BrandMark";
import { settings } from "@/config/settings";

const cols = [
  {
    title: "Shop",
    links: [
      { label: "All products", opts: linkOptions({ to: "/shop" }) },
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
      { label: "Combos", opts: linkOptions({ to: "/combos" }) },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Contact", opts: linkOptions({ to: "/contact" }) },
      { label: "FAQs", opts: linkOptions({ to: "/faq" }) },
      { label: "Shipping", opts: linkOptions({ to: "/shipping" }) },
      { label: "Returns", opts: linkOptions({ to: "/returns" }) },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Our story", opts: linkOptions({ to: "/about" }) },
      { label: "Quality", opts: linkOptions({ to: "/quality" }) },
      { label: "Bulk orders", opts: linkOptions({ to: "/bulk-orders" }) },
      { label: "Gifting", opts: linkOptions({ to: "/gifting" }) },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-border mt-0 border-t">
      <div className="container-page grid gap-9 pt-14 pb-6 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        <div>
          <BrandMark size="footer" />
          <p className="text-body mt-4 max-w-xs text-[14px] leading-[1.65]">{settings.tagline}</p>
          <form
            className="border-foreground mt-5 flex border-[1.5px]"
            onSubmit={(e) => e.preventDefault()}
          >
            <input
              type="email"
              placeholder="Email for notes from the desk"
              aria-label="Email for notes from the desk"
              className="placeholder:text-placeholder min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[13px] outline-none"
            />
            <button
              type="submit"
              className="bg-foreground text-background hover:bg-gold px-4 text-[16px]"
              aria-label="Subscribe"
            >
              →
            </button>
          </form>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.18em] uppercase">
              {c.title}
            </p>
            <ul className="mt-[11px] flex flex-col gap-[11px] text-[13px]">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link {...l.opts} className="hover:text-gold">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-border border-t">
        <div className="text-muted-foreground container-page flex flex-col gap-2 pt-[18px] pb-9 text-[11px] sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {settings.brandName}
          </p>
          <p>GST invoicing on every order · Certifications listed once verified</p>
        </div>
      </div>
    </footer>
  );
}
