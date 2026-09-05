import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PolicyTabs } from "@/components/common/PolicyTabs";
import { settings } from "@/config/settings";
import { useSeo } from "@/hooks/useSeo";

export interface LegalSection {
  heading: string;
  /** Each string is a paragraph; a nested array renders as a bulleted list. */
  body: (string | string[])[];
}

interface LegalPageProps {
  title: string;
  intro: string;
  /** Human-readable date the draft was last touched, shown as the "last updated" line. */
  updated: string;
  sections: LegalSection[];
  metaDescription: string;
  tabs?: "shipping" | "returns";
}

/**
 * Shared shell for the four policy pages.
 *
 * The banner is not decoration. Shipping, returns, privacy and terms are legally
 * operative documents, and the text below them is placeholder written to describe how
 * the site behaves — not reviewed by anyone qualified to publish it. Marking that plainly
 * is the only honest way to ship a policy page before review, and it is why the banner
 * lives in the shared component where an individual page cannot forget it.
 *
 * These pages are `noindex` for the same reason: a draft policy indexed by a search
 * engine is a draft policy being quoted back at you.
 */
export function LegalPage({
  title,
  intro,
  updated,
  sections,
  metaDescription,
  tabs,
}: LegalPageProps) {
  useSeo({
    title: `${title} | ${settings.brandName}`,
    description: metaDescription,
    noindex: true,
  });

  return (
    <div className="container-page py-14 pb-[72px]">
      <article className="max-w-[680px]">
        {tabs && <PolicyTabs active={tabs} />}
        <h1 className="font-display text-[clamp(32px,4.2vw,54px)] leading-[1.05]">{title}</h1>
        <p className="text-muted-foreground mt-4 text-[11px] font-semibold tracking-[0.14em] uppercase">
          Last updated: {updated}
        </p>
        <p className="text-body mt-4 text-[16px] leading-[1.7]">{intro}</p>

        <div role="note" className="border-border bg-sand mt-8 flex items-start gap-3 border p-5">
          <AlertTriangle className="text-gold mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold">Draft — to be reviewed before launch</p>
            <p className="text-muted-foreground mt-1">
              This text is placeholder policy written to describe how the site currently behaves. It
              has not been through legal review and is not yet binding. The final wording will be
              published here before the store goes live.
            </p>
          </div>
        </div>

        <div className="mt-4">
          {sections.map((s) => (
            <section key={s.heading} className="border-border border-t py-[26px]">
              <h2 className="heading-shout text-[17px]">{s.heading}</h2>
              <div className="text-body mt-3 space-y-4 text-[15px] leading-[1.75]">
                {s.body.map((block, i) =>
                  Array.isArray(block) ? (
                    <ul key={`${s.heading}-${i}`} className="space-y-0">
                      {block.map((item) => (
                        <li
                          key={item}
                          className="border-gold-light py-2 pl-4 text-[14px] leading-[1.6]"
                          style={{ borderLeftWidth: 2 }}
                        >
                          {item}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p key={`${s.heading}-${i}`}>{block}</p>
                  ),
                )}
              </div>
            </section>
          ))}
        </div>

        <nav aria-label="Other policies" className="border-border mt-8 border-t pt-6 text-sm">
          <p className="font-semibold">Other policies</p>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link to="/shipping" className="underline underline-offset-4">
                Shipping Policy
              </Link>
            </li>
            <li>
              <Link to="/returns" className="underline underline-offset-4">
                Returns &amp; Refunds
              </Link>
            </li>
            <li>
              <Link to="/privacy" className="underline underline-offset-4">
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link to="/terms" className="underline underline-offset-4">
                Terms of Service
              </Link>
            </li>
            <li>
              <Link to="/contact" className="underline underline-offset-4">
                Contact us
              </Link>
            </li>
          </ul>
        </nav>
      </article>
    </div>
  );
}
