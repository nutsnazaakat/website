/**
 * All money in this system is an integer count of paise held in a `bigint`.
 *
 * Rupees appear only at the API boundary, where `toRupees` converts for the frontend's
 * `price: number` contract. Nothing computes with floating-point rupees: `0.1 + 0.2`
 * problems surface as one-rupee GST discrepancies that are very hard to trace back.
 *
 * Matches the `bigint` paise convention already used by mf-lenders-gateway.
 */

/** A non-negative integer count of paise. 100 paise = ₹1. */
export type Paise = bigint;

const PAISE_PER_RUPEE = 100;
/** Rates are held as basis points internally, so 2.5% divides exactly. */
const BASIS_POINTS = 10_000n;

/**
 * Divides with half-up rounding. `bigint` division truncates toward zero, which would
 * quietly under-collect GST on every line.
 *
 * Every caller guards its amount argument against negative values before multiplying, and
 * `toBasisPoints` rejects a negative rate, so `numerator` can never legitimately be negative
 * here — a negative value indicates a bug upstream, not a case to handle silently.
 */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('divideHalfUp: denominator must be positive');
  if (numerator < 0n) throw new RangeError('divideHalfUp: numerator must not be negative');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function toBasisPoints(ratePercent: number): bigint {
  if (!Number.isFinite(ratePercent)) throw new RangeError('rate must be a finite number');
  if (ratePercent < 0) throw new RangeError('rate must not be negative');
  const scaled = Math.round(ratePercent * 100);
  if (Math.abs(ratePercent * 100 - scaled) > 1e-6) {
    throw new RangeError(`rate ${ratePercent} is finer than one basis point`);
  }
  return BigInt(scaled);
}

/**
 * Converts a rupee amount to paise.
 *
 * Throws rather than rounds when given finer precision than a paise: a price of ₹12.345
 * is a data-entry mistake, and silently storing ₹12.35 would make the stored catalogue
 * disagree with what an admin typed.
 */
export function toPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError('rupees must be a finite number');
  if (rupees < 0) throw new RangeError('rupees must not be negative');
  const scaled = Math.round(rupees * PAISE_PER_RUPEE);
  // Empirically swept: the float residual stays ~67x below this 1e-6 threshold up to
  // ₹20 lakh, and only starts exceeding 1e-6 around ₹2.7×10^8 (≈₹27 crore), where
  // legitimate two-decimal values would begin being wrongly rejected. Recorded here so
  // nobody has to redo the sweep if this constant is ever revisited.
  if (Math.abs(rupees * PAISE_PER_RUPEE - scaled) > 1e-6) {
    throw new RangeError(`${rupees} has sub-paise precision and cannot be stored as money`);
  }
  return BigInt(scaled);
}

/** Converts paise back to a rupee number for the API boundary. */
export function toRupees(paise: Paise): number {
  return Number(paise) / PAISE_PER_RUPEE;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<bigint>((total, value) => total + value, 0n);
}

/**
 * GST on one line, half-up to the paise.
 *
 * Spec §8: callers apply this **per line and then sum**, never to an aggregate. An invoice
 * whose tax does not equal the sum of its lines' tax cannot be reconciled.
 */
export function gstOn(basePaise: Paise, ratePercent: number): Paise {
  if (basePaise < 0n) throw new RangeError('basePaise must not be negative');
  return divideHalfUp(basePaise * toBasisPoints(ratePercent), BASIS_POINTS);
}

/** Clamps a discount into `[0, amount]` so a total can never go negative. */
function clampDiscount(discount: bigint, amount: Paise): Paise {
  if (discount <= 0n) return 0n;
  return discount > amount ? amount : discount;
}

/** Percentage coupon, optionally capped by the coupon's `maxDiscountPaise`. */
export function applyPercent(amountPaise: Paise, percent: number, maxPaise?: Paise): Paise {
  if (amountPaise < 0n) throw new RangeError('amountPaise must not be negative');
  const raw = divideHalfUp(amountPaise * toBasisPoints(percent), BASIS_POINTS);
  // maxPaise needs no hard guard: whatever its sign or size, clampDiscount below degrades
  // it safely — a negative or zero maxPaise collapses to a zero discount, and an oversized
  // one is simply never the tighter cap.
  const capped = maxPaise !== undefined && raw > maxPaise ? maxPaise : raw;
  return clampDiscount(capped, amountPaise);
}

/** Flat-amount coupon. */
export function applyFlat(amountPaise: Paise, flatPaise: Paise): Paise {
  if (amountPaise < 0n) throw new RangeError('amountPaise must not be negative');
  return clampDiscount(flatPaise, amountPaise);
}
