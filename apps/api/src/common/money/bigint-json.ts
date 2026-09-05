/**
 * Nest's response serialiser throws `TypeError: Do not know how to serialize a BigInt` the
 * first time a `bigint` reaches `JSON.stringify`. Money columns are `bigint` paise, so this
 * must be installed before anything serialises a response.
 *
 * Emitting a string rather than a number is deliberate: a paise value large enough to lose
 * precision as an IEEE-754 double must not silently round. API responses convert money to
 * rupee numbers via `toRupees` anyway; this polyfill is the safety net for anything that
 * slips through, and a string is visible in a test where a rounded number would not be.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

export {};
