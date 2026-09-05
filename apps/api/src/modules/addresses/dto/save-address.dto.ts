import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AddressDto } from '../../checkout/dto/place-order.dto';

/**
 * `POST /account/addresses` — the checkout address plus the two things a *book* needs.
 *
 * **Extends `AddressDto` rather than restating it.** That class already mirrors `addresses`' own
 * column widths field for field (`fullName` 120, `phone` via `PHONE_REGEX`, `email` 255, `line1`/
 * `line2` 255, `city`/`state` 80, `pincode` via `PINCODE_REGEX`) and it does so because a checkout
 * address and a saved address are the *same* eight fields — an address that clears checkout has to be
 * one the book can store, and vice versa. A second copy here would be a second opinion about what a
 * phone number is, and the first divergence would be a form the browser accepted and the server
 * refused. class-validator collects metadata from a class **and its ancestors**, so every rule above
 * is applied to an instance of this class; `save-address.dto.spec.ts` asserts that through the real
 * `ValidationPipe` rather than trusting it.
 *
 * **`label` is the field with no client-side bound at all, and it is the narrowest column.**
 * `savedAddressSchema` (`AddressForm.tsx:23`) is `z.string().min(2)` with **no maximum**, while
 * `addresses.label` is `varchar(40)`. So an ordinary long label — not a crafted one, a customer
 * typing out a whole line of an address as its name — reaches the driver as SQLSTATE `22001`
 * (*value too long for type character varying(40)*), which nothing catches, and the customer is shown
 * a **500** for what is plainly a 400. The same defect the `Idempotency-Key` cap closed in Task 9.
 * The `@MaxLength(40)` below is what turns it into a field-level validation failure the form can
 * render next to the input.
 *
 * `@MinLength(2)` carries the form's own wording, so the message a customer sees is the same whether
 * zod caught it or the server did.
 */
export class CreateAddressDto extends AddressDto {
  @ApiProperty({ maxLength: 40 })
  @IsString()
  @MinLength(2, { message: 'Name this address, e.g. Home' })
  @MaxLength(40)
  label: string;

  /**
   * Optional, and **absent is not the same as `false`** in only one direction.
   *
   * A book's *first* address is promoted to default whether or not this says so — nothing may leave a
   * customer with addresses and no default — so `isDefault: false` on an empty book still produces a
   * default. `AddressesService.create` owns that rule; this field is the customer *asking*, not
   * deciding.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * `PATCH /account/addresses/:id` — every field of the create DTO, each one optional.
 *
 * `PartialType` rather than a hand-written twin: it copies the inherited validation metadata and adds
 * `@IsOptional()` to each property, so the widths and patterns cannot drift between the two verbs.
 * The form sends the whole object on an edit and this accepts that; it also accepts a one-field patch,
 * which is what makes the verb honest.
 *
 * **There is no `id` here**, and the global pipe's `forbidNonWhitelisted` is what makes that a 400
 * rather than a silently ignored field: the address being patched is named by the path, so a body
 * that also carried an id would be two identifiers for one row and an obvious place for them to
 * disagree.
 */
export class UpdateAddressDto extends PartialType(CreateAddressDto) {}
