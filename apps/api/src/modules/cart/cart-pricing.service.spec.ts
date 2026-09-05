import { CartPricingService } from './cart-pricing.service';

const settings = { freeShippingThreshold: 999, flatShippingRate: 79 };

/** A priced retail line, carrying its **line total**: 2 × ₹299 = ₹598 at 5% GST. */
const retailLine = (qty = 2, unitPaise = 29900n) => ({
  mode: 'RETAIL' as const,
  qty,
  kg: null,
  lineTotalPaise: unitPaise * BigInt(qty),
  gstRate: 5,
  quoteRequired: false,
});

describe('CartPricingService.totals', () => {
  const service = new CartPricingService();

  it('sums line totals into a subtotal in rupees', () => {
    const totals = service.totals([retailLine()], settings);
    expect(totals.subtotal).toBe(598);
  });

  /**
   * Per line, then summed — spec §8. **Verified against the real `gstOn`**: three lines of ₹33.33 at 5%
   * give 167 paise each and 501 altogether, where taxing the ₹99.99 aggregate gives 500. The difference
   * is the whole reason the rule exists, so it is asserted rather than described.
   */
  it('computes GST per line and sums it, never taxing the aggregate', () => {
    const line = { ...retailLine(1, 3333n) };
    const totals = service.totals([line, { ...line }, { ...line }], settings);
    expect(totals.gst).toBe(5.01);
  });

  /**
   * The rate comes off the line, not off the basket. Every other fixture in this file is 5%, so a
   * `gstOn(total, 5)` with the rate baked in passes all of them; a basket mixing rates is what
   * distinguishes them. Packaged food genuinely spans 5%, 12% and 18%.
   */
  it('taxes each line at its own rate, not one rate for the whole basket', () => {
    const totals = service.totals(
      [
        { ...retailLine(1, 10000n), gstRate: 5 }, // ₹100 at 5%  → ₹5
        { ...retailLine(1, 10000n), gstRate: 18 }, // ₹100 at 18% → ₹18
      ],
      settings,
    );
    expect(totals.subtotal).toBe(200);
    expect(totals.gst).toBe(23);
  });

  it('charges flat shipping below the free threshold and nothing above it', () => {
    expect(service.totals([retailLine(1, 50000n)], settings).shipping).toBe(79);
    expect(service.totals([retailLine(1, 120000n)], settings).shipping).toBe(0);
  });

  /**
   * Two decisions this endpoint must make the **same way the cart page already makes them**, because
   * the plan declares the server authoritative: the client replaces its own figure with this one, so
   * any disagreement is a customer being charged more than the basket showed them.
   *
   * `frontend/src/features/cart/cart-math.ts:45` is the existing rule, verbatim:
   *
   *     const shipping = subtotal === 0 || subtotal >= freeShippingThreshold ? 0 : SHIPPING_FLAT;
   *
   * So: **`>=`, not `>`** — ₹999 exactly ships free; and the comparison is against the **pre-GST
   * subtotal**, not the total. The two cases in the test above are both far from the boundary and pass
   * under either reading of both decisions, which is why these are separate.
   */
  it('ships free at exactly the threshold, and charges a paise below it', () => {
    // ₹999.00 — the boundary itself.
    expect(service.totals([retailLine(1, 99900n)], settings).shipping).toBe(0);
    // ₹998.99 — one paise below it.
    expect(service.totals([retailLine(1, 99899n)], settings).shipping).toBe(79);
  });

  it('compares the threshold against the subtotal, not the GST-inclusive total', () => {
    // ₹980 subtotal and ₹49 GST at 5%, so ₹1029 before shipping. Under the correct rule this is below
    // the ₹999 threshold and pays shipping, for a ₹1108 total; comparing subtotal-plus-GST instead
    // would ship it free and lose ₹79 a basket, silently, on every order in this band.
    const totals = service.totals([retailLine(1, 98000n)], settings);
    expect(totals.subtotal).toBe(980);
    expect(totals.total).toBeGreaterThan(settings.freeShippingThreshold);
    expect(totals.shipping).toBe(79);
  });

  /**
   * Both numbers come from the caller's settings row, so neither may be baked in here. The seeded
   * values happen to be ₹999 and ₹79 (`backend/src/database/seeds/settings.seed.ts`), which every
   * other fixture in this file uses — meaning a hardcoded 999 or 79 passes all of them.
   */
  it('reads the threshold and the flat rate from the settings it is given', () => {
    const raised = { freeShippingThreshold: 1500, flatShippingRate: 49 };
    // ₹999 clears the seeded threshold but not this one, and the charge is this tariff's ₹49.
    expect(service.totals([retailLine(1, 99900n)], raised).shipping).toBe(49);
    // ₹1500 exactly — the boundary of *this* threshold.
    expect(service.totals([retailLine(1, 150000n)], raised).shipping).toBe(0);
  });

  it('charges no shipping on an empty basket', () => {
    const totals = service.totals([], settings);
    expect(totals).toEqual({
      subtotal: 0,
      gst: 0,
      shipping: 0,
      total: 0,
      hasQuoteLines: false,
      hasUnpriceableLines: false,
    });
  });

  it('adds subtotal, GST and shipping into the total', () => {
    const totals = service.totals([retailLine()], settings);
    expect(totals.total).toBe(totals.subtotal + totals.gst + totals.shipping);
  });

  /**
   * The total is summed in paise and converted once, which is not the same operation as adding the
   * three rupee figures — and the difference is observable, so it is pinned rather than assumed.
   *
   * Measured against the real `gstOn`: a ₹23 line at 12% is ₹2.76 GST, and ₹23 + ₹2.76 + ₹79 is
   * **₹104.76** summed in paise but **104.75999999999999** summed as rupee floats. 1,239 of the first
   * 20,000 whole-rupee subtotals diverge this way at 12% and 1,623 at 18% — and **none at 5%**, which
   * is why every 5% fixture in this file, including the test above, misses it entirely.
   */
  it('sums the total in paise, so no float artefact reaches the wire', () => {
    const totals = service.totals([{ ...retailLine(1, 2300n), gstRate: 12 }], settings);
    expect(totals.total).toBe(104.76);
  });

  /**
   * A quote-required bulk line has no price, so it must not be counted as free. `hasQuoteLines` is
   * what blocks checkout; a line silently contributing zero would let someone check out a 50kg order
   * for the cost of shipping.
   */
  it('flags quote lines and excludes them from the money', () => {
    const totals = service.totals(
      [
        retailLine(1, 29900n),
        {
          mode: 'BULK',
          qty: 1,
          kg: '50.00',
          lineTotalPaise: null,
          gstRate: 5,
          quoteRequired: true,
        },
      ],
      settings,
    );
    expect(totals.hasQuoteLines).toBe(true);
    expect(totals.subtotal).toBe(299);
  });

  /**
   * The flag and the money must be decided by the same predicate.
   *
   * There are two ways a line can be unpriceable — `quoteRequired`, and a null `lineTotalPaise` — and
   * the fixture above sets **both**, so it cannot tell apart a flag that reads one from a flag that
   * reads the other. These two cases separate them, one per direction.
   *
   * The first is the dangerous one: a line the caller could not price but did not mark contributes
   * zero to the subtotal, and if the flag missed it, checkout would go through — the 50kg order for
   * the cost of shipping, arrived at by a different route.
   */
  /**
   * **`hasQuoteLines` must mean "needs a quote", not "was left out of the money".** They are different
   * questions and the frontend branches on the answer in three places:
   * `routes/cart.tsx:114` renders "Quote-required items are not included in this total",
   * `routes/cart.tsx:140` renders a **Request Quote** button to `/business/rfqs/new`, and
   * `features/checkout/components/CheckoutForm.tsx:99` sets `isB2b` from it and switches the form to
   * `b2bCheckoutSchema`, which **demands a GSTIN**.
   *
   * So conflating the two routes a B2C customer whose only problem is one sold-out bag onto the
   * business track and asks them for a GST number. `hasUnpriceableLines` carries the broader meaning
   * that the money path needs, and keeps the honesty of the earlier fix: an unpriced line still cannot
   * contribute zero to the subtotal unnoticed.
   */
  it('flags a genuine quote line on both, since a quote line is also unpriceable', () => {
    const totals = service.totals(
      [
        retailLine(1, 29900n),
        {
          mode: 'BULK' as const,
          qty: 1,
          kg: '50.00',
          lineTotalPaise: null,
          gstRate: 5,
          quoteRequired: true,
        },
      ],
      settings,
    );
    expect(totals.hasQuoteLines).toBe(true);
    expect(totals.hasUnpriceableLines).toBe(true);
  });

  it('flags a line it could not price, even when nothing marked it quote-required', () => {
    const unpriced = { ...retailLine(1), lineTotalPaise: null, quoteRequired: false };
    const totals = service.totals([retailLine(1, 29900n), unpriced], settings);
    expect(totals.subtotal).toBe(299);
    // `hasUnpriceableLines`, not `hasQuoteLines` — this test originally asserted the latter, which was
    // the conflation that routed a retail basket with one sold-out pack onto the business track. The
    // intent is unchanged and still pinned: an unpriced line may not contribute zero to the subtotal
    // and clear checkout unnoticed.
    expect(totals.hasUnpriceableLines).toBe(true);
    expect(totals.hasQuoteLines).toBe(false);
  });

  it('flags a quote line that arrives carrying a price, and does not bill it', () => {
    const priced = { ...retailLine(1, 29900n), quoteRequired: true };
    const totals = service.totals([retailLine(1, 29900n), priced], settings);
    expect(totals.subtotal).toBe(299);
    expect(totals.hasQuoteLines).toBe(true);
    expect(totals.hasUnpriceableLines).toBe(true);
  });
});
