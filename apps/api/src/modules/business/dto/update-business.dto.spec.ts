import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { UpdateBusinessDto } from './update-business.dto';

/**
 * Validated through the **production** pipe, not a locally-built one — `create-rfq.dto.spec.ts`'s
 * own reasoning: a hand-rolled `new ValidationPipe({ whitelist: true })` would assert these
 * decorators against this file's own configuration rather than the one the server actually runs.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: UpdateBusinessDto as never }));

const refusalOf = async (value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

/** A body `business/profile.tsx`'s form really sends, with every field at a legal value. */
const VALID = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  gstin: '29ABCDE1234F1Z5',
  businessType: 'Sweet shop',
  billingAddressId: '123e4567-e89b-12d3-a456-426614174000',
  shippingAddressId: '9d3f4a2e-2b3c-4d5e-8f6a-1b2c3d4e5f6a',
};

describe('UpdateBusinessDto', () => {
  it('accepts the body the form sends', async () => {
    await expect(validate(VALID)).resolves.toEqual(VALID);
  });

  it('accepts no GSTIN and both addresses cleared', async () => {
    const body = {
      ...VALID,
      gstin: undefined,
      billingAddressId: null,
      shippingAddressId: null,
    };
    const { gstin, ...withoutGstin } = body;
    expect(gstin).toBeUndefined();
    await expect(validate(withoutGstin)).resolves.toEqual(withoutGstin);
  });

  it('refuses a company name wider than the column, so a long name is a 400 and not a 500', async () => {
    const failure = await refusalOf({ ...VALID, companyName: 'H'.repeat(161) });
    expect(failure.getStatus()).toBe(400);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details).toHaveProperty('companyName');
  });

  it('refuses an empty mobile', async () => {
    const failure = await refusalOf({ ...VALID, mobile: '' });
    expect(failure.details).toHaveProperty('mobile');
  });

  /**
   * The case an empty string cannot exercise: `@IsOptional()` skips its sibling validators only
   * for `null`/`undefined`, not for `''` — a present empty string already fails
   * `@Matches(PHONE_REGEX)` whether or not `@IsOptional()` is on the field, so the case above
   * passes identically either way. Omitting the key entirely is the one request an
   * `@IsOptional()` mobile would let through silently, erasing the number a business already
   * gave the sales desk.
   */
  it('refuses a request that omits mobile entirely — no @IsOptional() on this field', async () => {
    const { mobile, ...withoutMobile } = VALID;
    expect(mobile).toBeDefined();
    const failure = await refusalOf(withoutMobile);
    expect(failure.details).toHaveProperty('mobile');
  });

  it('refuses a malformed mobile number', async () => {
    const failure = await refusalOf({ ...VALID, mobile: '12345' });
    expect(failure.details).toHaveProperty('mobile');
  });

  it('refuses a businessType outside the vocabulary the select actually offers', async () => {
    const failure = await refusalOf({ ...VALID, businessType: 'Something else entirely' });
    expect(failure.details).toHaveProperty('businessType');
  });

  it('refuses a malformed GSTIN', async () => {
    const failure = await refusalOf({ ...VALID, gstin: 'not-a-gstin' });
    expect(failure.details).toHaveProperty('gstin');
  });

  it('refuses a non-uuid billingAddressId with 400, not a 500 further down the stack', async () => {
    const failure = await refusalOf({ ...VALID, billingAddressId: 'adr-b2c-home' });
    expect(failure.details).toHaveProperty('billingAddressId');
  });

  it('refuses a non-uuid shippingAddressId with 400', async () => {
    const failure = await refusalOf({ ...VALID, shippingAddressId: 'not-a-uuid' });
    expect(failure.details).toHaveProperty('shippingAddressId');
  });

  it('refuses a client-supplied segment, so a customer cannot set their own price band', async () => {
    const failure = await refusalOf({ ...VALID, segment: 'retailer' });
    expect(failure.details).toHaveProperty('segment');
  });

  it('refuses a client-supplied assignedSalespersonId', async () => {
    const failure = await refusalOf({ ...VALID, assignedSalespersonId: VALID.billingAddressId });
    expect(failure.details).toHaveProperty('assignedSalespersonId');
  });
});
