import { ApiPropertyOptional } from '@nestjs/swagger';
import { PHONE_REGEX } from '@nutwala/shared';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * `PATCH /account/profile` — **two fields, and the interesting part is the ones that are absent.**
 *
 * `whitelist` + `forbidNonWhitelisted` (`VALIDATION_PIPE_OPTIONS`) means a property with no
 * validation decorator on this class is a **400**, not a value quietly ignored. So the three
 * exclusions below are enforced by the *absence* of a declaration, which is a fragile-looking
 * mechanism worth naming: adding `email?: string` here with any decorator on it is all it would take
 * to open a hole, and `update-profile.dto.spec.ts` asserts each one is refused rather than trusting
 * the omission.
 *
 * - **Not `email`.** It is the login identifier — `uq_users_email` is a case-insensitive functional
 *   unique index on it — so changing it is an account-recovery flow with verification, not a profile
 *   edit. `profile.tsx` keeps that input `readOnly disabled` with its own explanation.
 * - **Not `role`.** Self-service privilege escalation. The one legitimate promotion is
 *   `POST /auth/upgrade-to-business` (`auth.controller.ts`), which is `CUSTOMER -> BUSINESS` only and
 *   goes nowhere near `ADMIN`.
 * - **Not `isActive`.** Deactivation is an admin action, and §9's login flow checks it *after* the
 *   bcrypt comparison precisely so it cannot be used as an oracle; a customer who could flip it could
 *   lock themselves out with no way back in.
 *
 * **`name` is bounded and `phone` is not, and that asymmetry is deliberate.** `users.name` is
 * `varchar(120)` and `users.phone` is `varchar(15)` — both measured off `user.entity.ts`. `PHONE_REGEX`
 * is `/^[6-9]\d{9}$/`, anchored at both ends, so it admits exactly ten characters and bounds the
 * column by itself; a `@MaxLength(15)` beside it would be a second, weaker statement of the same rule.
 * `name` has no such pattern, so without `@MaxLength(120)` a long value reaches the driver as SQLSTATE
 * **22001** (*value too long for type character varying(120)*), nothing catches `QueryFailedError`, and
 * the customer is shown a **500** for what is plainly a 400 — the same defect the `Idempotency-Key`
 * cap closed in Task 9 and the address `label` closed in Task 21.
 *
 * **The messages are `RegisterDto`'s, word for word, and that is asserted rather than hoped for.**
 * The same two fields are collected at registration, so a customer who mistypes a phone number must
 * read the same sentence whichever form they are on. `update-profile.dto.spec.ts` validates *both*
 * classes against the same bad input and compares the two `details` objects, which is what keeps them
 * together without this class inheriting registration's password and company rules.
 */
export class UpdateProfileDto {
  /**
   * Trimmed **before** validation, which is what makes `@MinLength(2)` mean something.
   *
   * `@Transform` runs inside `plainToInstance`, so the pipe validates the trimmed value and the
   * service receives it. Without it `{ name: '  ' }` is a *present* two-character string that
   * satisfies every decorator here, and the only remaining question is whether the service trims:
   * if it does the row gets `''` — a blank name on every future order, delivered by a **200** — and
   * if it does not, the name is stored with its padding and renders ragged next to a seeded one.
   * Trimming first turns both into a field-level 400 the form can put under the input.
   *
   * `AddressesService` deliberately does *not* trim its `fullName`, for a reason that does not apply
   * here: `addressSchema` does not trim either, so trimming there would make the round trip lossy for
   * a value the customer can see. `auth.service.ts:76` **does** trim this exact field on registration
   * (`input.name.trim()`), so not trimming it here would make one account's name depend on which form
   * last wrote it.
   */
  @ApiPropertyOptional({ maxLength: 120, example: 'Asha Rao' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'Enter your full name' })
  @MaxLength(120)
  name?: string;

  /** `PHONE_REGEX` from `@nutwala/shared` — the rule the checkout form and registration both apply. */
  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @Matches(PHONE_REGEX, { message: 'Enter a valid 10-digit Indian mobile number' })
  phone?: string;
}
