/**
 * What goes inside each combo box.
 *
 * **Why this is a constant and not a table.** Spec §5 designs no combo-composition entity, and
 * `GET /catalog/combos` needs one. Rather than invent schema in a read-only plan, the six editorial
 * rows live here, ported verbatim from `frontend/src/mocks/combos.ts`.
 *
 * **Deferred decision, owned by the admin plan:** when admin can create a combo, this needs a real
 * entity — `ComboComponent(comboProductId, componentProductId, size, sortOrder)` — with foreign keys,
 * so deleting a product cannot leave a dangling slug that renders as a missing component. Until then
 * a bad slug here surfaces as an omitted combo, which `combos.service.ts` logs rather than hides.
 *
 * Only slugs and pack sizes are stored. Every price, MRP and savings figure is derived from the live
 * catalogue on each read, so a price edit can never leave a stale savings claim on the combos page.
 *
 * Each box holds 4 × 250g, which is why the box's own 1kg retail pack is the combo price.
 */
export interface ComboComposition {
  /** Slug of the catalogue product that *is* the box. */
  slug: string;
  occasion: string;
  blurb: string;
  components: { slug: string; size: string }[];
}

export const COMBO_COMPOSITIONS: ComboComposition[] = [
  {
    slug: 'daily-dry-fruit-combo',
    occasion: 'Everyday',
    blurb:
      'The four things most kitchens run out of first, in the sizes a household actually finishes.',
    components: [
      { slug: 'premium-california-almonds', size: '250g' },
      { slug: 'w320-cashews', size: '250g' },
      { slug: 'afghani-black-raisins', size: '250g' },
      { slug: 'premium-anjeer', size: '250g' },
    ],
  },
  {
    slug: 'premium-nuts-combo',
    occasion: 'Gifting',
    blurb:
      'Top-grade kernels only — no fillers, no raisins. The box to send when the recipient knows the difference.',
    components: [
      { slug: 'gurbandi-almonds', size: '250g' },
      { slug: 'w240-cashews', size: '250g' },
      { slug: 'premium-pistachios', size: '250g' },
      { slug: 'california-walnuts', size: '250g' },
    ],
  },
  {
    slug: 'premium-family-combo',
    occasion: 'Household',
    blurb:
      'A month of snacking and cooking for a family of four, with dates in place of the usual raisins.',
    components: [
      { slug: 'premium-california-almonds', size: '250g' },
      { slug: 'w320-cashews', size: '250g' },
      { slug: 'premium-anjeer', size: '250g' },
      { slug: 'medjool-dates', size: '250g' },
    ],
  },
  {
    slug: 'office-snack-combo',
    occasion: 'Workplace',
    blurb:
      'Light, low-mess and desk-friendly. Built for pantry baskets that get raided by fifteen people.',
    components: [
      { slug: 'roasted-makhana', size: '250g' },
      { slug: 'peri-peri-makhana', size: '250g' },
      { slug: 'everyday-trail-mix', size: '250g' },
      { slug: 'roasted-salted-cashews', size: '250g' },
    ],
  },
  {
    slug: 'trail-mix-combo',
    occasion: 'Active',
    blurb:
      'Nuts, seeds and dried fruit to mix your own ratio, for people who never like the pre-made blend.',
    components: [
      { slug: 'everyday-trail-mix', size: '250g' },
      { slug: 'california-walnuts', size: '250g' },
      { slug: 'pumpkin-seeds', size: '250g' },
      { slug: 'afghani-black-raisins', size: '250g' },
    ],
  },
  {
    slug: 'festive-combo',
    occasion: 'Festive',
    blurb: 'The Diwali and Eid standard — pistachios and medjool alongside the everyday two.',
    components: [
      { slug: 'premium-california-almonds', size: '250g' },
      { slug: 'w320-cashews', size: '250g' },
      { slug: 'premium-pistachios', size: '250g' },
      { slug: 'medjool-dates', size: '250g' },
    ],
  },
];
