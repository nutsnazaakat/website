import { Link } from "@tanstack/react-router";
import type { OrderLine } from "../types";

/**
 * An order line's product name, linked when the order remembers which product it was.
 *
 * **The `slug` test is the whole component**, and it is a rule rather than a tidy-up: `OrderLine.slug`
 * is optional, so a line whose product has since been deleted still names what was bought and simply
 * does not link. Rendering an unconditional `<Link>` would put `/product/undefined` on the page.
 *
 * Shared by `/account/orders/$id` and `/order-success/$id` because both render the same order and the
 * linking rule is one decision. It lived in the first of those as a local component; the confirmation
 * needed it too — `order_items.product_slug` is a snapshot column, so a just-placed order links
 * exactly as a seeded one does, which is disagreement 6 resolving itself — and a second copy is the
 * one that would drift.
 */
export function LineName({ item }: { item: OrderLine }) {
  if (!item.slug) return <>{item.name}</>;
  return (
    <Link to="/product/$slug" params={{ slug: item.slug }} className="hover:underline">
      {item.name}
    </Link>
  );
}
