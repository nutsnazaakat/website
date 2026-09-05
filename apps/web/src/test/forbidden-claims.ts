/**
 * The claim vocabulary the brief forbids unless an admin has configured it
 * (§25: *"Do not claim certifications unless configured by Admin"*; §26: *"Certification
 * information must be editable from Admin"*).
 *
 * It lives in its own module for two reasons. One list means a page audited for these
 * words is audited for all of them, rather than each test remembering a different subset.
 * And the project's claims audit greps `*.tsx` for exactly these strings — keeping the
 * vocabulary in a `.ts` module means the assertions that *prove the words are absent from
 * the UI* do not themselves show up as hits in that audit.
 */
export const FORBIDDEN_CLAIMS: RegExp[] = [
  /fssai/i,
  /\biso[ -]\d/i,
  /certified/i,
  /lab.tested/i,
  /\borganic\b/i,
  /100% pure/i,
];
