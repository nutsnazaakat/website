import { Link, linkOptions } from "@tanstack/react-router";
import { BrandMark } from "@/components/common/BrandMark";
import { useSiteSettings } from "@/config/useSiteSettings";

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
  const settings = useSiteSettings();
  return (
    <footer className="border-border mt-0 border-t">
      <div className="container-page grid [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] gap-9 pt-14 pb-6">
        <div>
          <BrandMark size="footer" />
          <p className="text-body mt-4 max-w-xs text-[14px] leading-[1.65]">{settings.tagline}</p>
          <Link to="/contact" className="section-link mt-5 inline-block">
            Talk to our team
          </Link>
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
          <div className="flex flex-wrap gap-4">
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/returns">Returns</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
