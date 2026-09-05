import { ApiProperty } from '@nestjs/swagger';
import { PINCODE_REGEX } from '@nutwala/shared';
import { Matches } from 'class-validator';

/**
 * Everything `POST /checkout/pincode` takes: six digits.
 *
 * **`POST` with a body, not `GET /checkout/pincode/:pincode`.** Spec §6.1 lists it as a `POST` in the
 * public block, and a `GET` with a path parameter would be more natural for a six-digit lookup and
 * would cache. It is still not worth deviating: the spec is what the admin repository's developers
 * will read, `POST /checkout/coupon/preview` beside it is already a `POST`, and a divergence nobody
 * needs costs more than the elegance buys. Changing it means amending §6.1 the way §5.3's
 * `guest_token` deviation is recorded — not leaving the two documents disagreeing.
 *
 * **`PINCODE_REGEX` is `/^\d{6}$/`, and that is the whole rule** — the form's rule, from the same
 * constant `CheckoutForm`'s zod schema imports, so the server is not a second opinion about what a
 * pincode looks like. It deliberately does **not** encode deliverability: the Phase 1 mock's
 * `/^[2-8]\d{5}$/` conflated the two and therefore refused every Delhi pincode as *malformed*, when
 * `110001` is a perfectly well-formed pincode that the `serviceable_pincodes` table happens to
 * deliver to. Whether we deliver is a row in that table and a `200` saying `serviceable: false`;
 * whether it is six digits is a `400`. Collapsing them loses the customer's ability to tell a typo
 * from a delivery limit.
 *
 * `@Matches` alone, with no `@IsString()`, mirroring `AddressDto.pincode`. `class-validator`'s
 * `matches` is `typeof value === 'string' && pattern.test(value)`, so a number or an object fails it
 * rather than throwing, and one decorator is enough to whitelist the property under the global
 * pipe's `whitelist` + `forbidNonWhitelisted`.
 */
export class CheckPincodeDto {
  @ApiProperty({ pattern: PINCODE_REGEX.source, example: '560001' })
  @Matches(PINCODE_REGEX, { message: 'Enter a valid 6-digit pincode' })
  pincode: string;
}
