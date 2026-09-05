import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { CreateAddressDto, UpdateAddressDto } from './save-address.dto';

/**
 * The address DTOs, validated through the **production** pipe.
 *
 * `VALIDATION_PIPE_OPTIONS` is imported from `app.module.ts` rather than restated, which is what its
 * own docblock asks for: a locally-built `new ValidationPipe({ whitelist: true })` would assert these
 * decorators against *this file's* configuration, so a `skipMissingProperties` added there or a
 * dropped `forbidNonWhitelisted` would leave every case here green while the server accepted what they
 * claim it rejects.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (metatype: unknown, value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: metatype as never }));

const refusalOf = async (metatype: unknown, value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(metatype, value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

/** A body the form really sends, with every field at a legal value. */
const VALID = {
  label: 'Home',
  fullName: 'Asha Rao',
  phone: '9876543210',
  email: 'b2c@demo.in',
  line1: '12 Residency Road',
  line2: 'Near Mayo Hall',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560025',
  isDefault: true,
};

describe('CreateAddressDto', () => {
  it('accepts the body the form sends', async () => {
    await expect(validate(CreateAddressDto, VALID)).resolves.toEqual(VALID);
  });

  it('accepts an address with no second line and no default flag', async () => {
    const { line2, isDefault, ...rest } = VALID;
    expect({ line2, isDefault }).toBeDefined();
    await expect(validate(CreateAddressDto, rest)).resolves.toEqual(rest);
  });

  /**
   * **The 500-that-should-be-a-400, closed.**
   *
   * `addresses.label` is `varchar(40)` — the narrowest column on the table — and
   * `savedAddressSchema` (`AddressForm.tsx:23`) bounds it with `min(2)` and **no maximum at all**, so
   * this is reachable by a customer typing a long name for an address rather than by an attacker
   * crafting one. Without `@MaxLength(40)` the value reaches the driver, Postgres raises SQLSTATE
   * `22001` (*value too long for type character varying(40)*), nothing catches a `QueryFailedError`,
   * and the answer is **500 Internal server error** — with the address silently not saved and nothing
   * on screen to say which field was at fault.
   */
  it('refuses a label wider than the column, so a long name is a 400 and not a 500', async () => {
    const failure = await refusalOf(CreateAddressDto, { ...VALID, label: 'H'.repeat(41) });

    expect(failure.getStatus()).toBe(400);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details).toEqual({
      label: ['label must be shorter than or equal to 40 characters'],
    });
  });

  /** The boundary itself is legal — an off-by-one in the bound would refuse a valid label. */
  it('accepts a label exactly as wide as the column', async () => {
    await expect(validate(CreateAddressDto, { ...VALID, label: 'H'.repeat(40) })).resolves.toEqual({
      ...VALID,
      label: 'H'.repeat(40),
    });
  });

  it('refuses a label too short to name anything, in the form’s own words', async () => {
    const failure = await refusalOf(CreateAddressDto, { ...VALID, label: 'H' });
    expect(failure.details).toEqual({ label: ['Name this address, e.g. Home'] });
  });

  it('refuses an address with no label at all', async () => {
    const { label, ...rest } = VALID;
    expect(label).toBe('Home');
    await expect(validate(CreateAddressDto, rest)).rejects.toBeInstanceOf(DomainError);
  });

  /**
   * **The whole risk of `extends AddressDto` in one case.**
   *
   * class-validator collects metadata from a class *and its ancestors*, so the eight inherited rules
   * apply to an instance of the subclass — but that is a library behaviour, not a language one, and if
   * it did not hold this DTO would validate `label` alone and let every other field through unbounded.
   * All three of these come from the parent: `PHONE_REGEX`, `varchar(120)` and `PINCODE_REGEX`.
   */
  it('applies the address rules it inherits rather than only its own', async () => {
    const failure = await refusalOf(CreateAddressDto, {
      ...VALID,
      phone: '12345',
      fullName: 'A'.repeat(121),
      pincode: '56002',
    });

    expect(Object.keys(failure.details ?? {}).sort()).toEqual(['fullName', 'phone', 'pincode']);
  });

  /**
   * **`line2: ''` is accepted here, and that is the finding rather than an oversight.**
   *
   * `AddressForm`'s `emptyValues` sets `line2: ''`, and `@IsOptional()` skips its siblings only for
   * `undefined` and `null` — an empty string is a *present* value that satisfies `@IsString()` and
   * `@MaxLength(255)`. So the DTO cannot be the place this is fixed without also rejecting a form
   * submission the browser considers complete; `AddressesService` normalises it to `null` instead, and
   * this case is what stops someone "tidying" that normalisation away in the belief that validation
   * already handles it.
   */
  it('accepts an empty second line, which is why the service has to normalise one', async () => {
    await expect(validate(CreateAddressDto, { ...VALID, line2: '' })).resolves.toEqual({
      ...VALID,
      line2: '',
    });
  });

  /**
   * `forbidNonWhitelisted`, and `id` is the property that matters: the page this replaces minted its
   * own `adr-${Date.now()}` ids and sent them in the body. A silently ignored `id` would look like it
   * worked while the row carried a server-allocated uuid, so the first client to rely on the one it
   * sent would break at a distance.
   */
  it('refuses a client-supplied id rather than ignoring it', async () => {
    const failure = await refusalOf(CreateAddressDto, { ...VALID, id: 'adr-b2c-home' });
    expect(failure.details).toEqual({ id: ['property id should not exist'] });
  });
});

describe('UpdateAddressDto', () => {
  /**
   * `PartialType` is what makes a PATCH a patch. Every field optional, so a client may send one.
   */
  it('accepts a single field', async () => {
    await expect(validate(UpdateAddressDto, { label: 'Home office' })).resolves.toEqual({
      label: 'Home office',
    });
  });

  it('accepts the whole body the form sends on an edit', async () => {
    await expect(validate(UpdateAddressDto, VALID)).resolves.toEqual(VALID);
  });

  /**
   * **The rules survive `PartialType`, which makes optional and lenient different things.**
   *
   * `PartialType` adds `@IsOptional()` to each inherited property and copies the rest of the metadata;
   * an implementation that only did the first half would leave `PATCH` as the unbounded way into the
   * same `varchar(40)` this file's create case protects — a 500 reachable through the other verb.
   */
  it('still bounds a label it is not required to receive', async () => {
    const failure = await refusalOf(UpdateAddressDto, { label: 'H'.repeat(41) });
    expect(failure.details).toEqual({
      label: ['label must be shorter than or equal to 40 characters'],
    });
  });

  it('still applies the inherited phone rule', async () => {
    const failure = await refusalOf(UpdateAddressDto, { phone: '12345' });
    expect(failure.details).toEqual({
      phone: ['Enter a valid 10-digit Indian mobile number'],
    });
  });

  /**
   * An empty patch is a legal request — every field is optional — so the service has to cope with a
   * write that sets nothing. `UPDATE … SET` with no assignments is a syntax error rather than a no-op,
   * which is why `AddressesService.update` counts the patch's keys before issuing one.
   */
  it('accepts an empty body, which the service must not turn into an empty UPDATE', async () => {
    await expect(validate(UpdateAddressDto, {})).resolves.toEqual({});
  });

  /** The address is named by the path. A body that named one too would be two identifiers for it. */
  it('refuses an id in the body', async () => {
    const failure = await refusalOf(UpdateAddressDto, {
      id: 'a1b2c3d4-0000-4000-8000-000000000001',
    });
    expect(failure.details).toEqual({ id: ['property id should not exist'] });
  });
});
