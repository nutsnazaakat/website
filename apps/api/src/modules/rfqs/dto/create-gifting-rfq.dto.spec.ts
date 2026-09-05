import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { CreateGiftingRfqDto } from './create-gifting-rfq.dto';

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: CreateGiftingRfqDto as never }));

const refusalOf = async (value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

/** A body `giftingSchema` really sends, with every field at a legal value. */
const VALID = {
  companyName: 'Anand Sweets & Namkeen',
  contactPerson: 'Rakesh Anand',
  mobile: '9845012345',
  email: 'purchase@anandsweets.example',
  gstin: '29ABCDE1234F1Z5',
  businessType: 'Corporate gifting',
  pincode: '560004',
  occasion: 'Diwali',
  giftBoxSlug: 'festive-gift-box',
  boxes: 50,
  budgetPerBox: 1500,
  brandingRequired: true,
  deliveryDate: '2026-10-15',
  message: 'Logo on the lid, please.',
};

describe('CreateGiftingRfqDto', () => {
  it('accepts the body the form sends', async () => {
    await expect(validate(VALID)).resolves.toEqual(VALID);
  });

  it('accepts an enquiry with no GSTIN and no message', async () => {
    const { gstin, message, ...rest } = VALID;
    expect({ gstin, message }).toBeDefined();
    await expect(validate(rest)).resolves.toEqual(rest);
  });

  /**
   * The whole reason this DTO exists rather than reusing `CreateRfqDto`: the gifting form asks
   * for none of `packaging`/`frequency`/`lines`, and — measured — sending them anyway is refused
   * outright by `forbidNonWhitelisted` rather than silently ignored.
   */
  it('rejects packaging, frequency and lines as fields it does not carry', async () => {
    const failure = await refusalOf({
      ...VALID,
      packaging: 'Bulk sacks (25 kg)',
      frequency: 'One-time',
      lines: [{ productSlug: 'festive-gift-box', kg: 1 }],
    });
    expect(failure.code).toBe('VALIDATION_FAILED');
  });

  it('requires businessType, the one field this DTO adds beyond the gifting form', async () => {
    const { businessType, ...withoutBusinessType } = VALID;
    expect(businessType).toBeDefined();
    const failure = await refusalOf(withoutBusinessType);
    expect(failure.details).toHaveProperty('businessType');
  });

  it('refuses an occasion outside the vocabulary the select actually offers', async () => {
    const failure = await refusalOf({ ...VALID, occasion: 'A Tuesday' });
    expect(failure.details).toHaveProperty('occasion');
  });

  it('refuses a non-integer box count', async () => {
    const failure = await refusalOf({ ...VALID, boxes: 12.5 });
    expect(failure.details).toHaveProperty('boxes');
  });

  it('refuses a zero or negative budget per box', async () => {
    const failure = await refusalOf({ ...VALID, budgetPerBox: 0 });
    expect(failure.details).toHaveProperty('budgetPerBox');
  });

  it('refuses a delivery date that is not a real date', async () => {
    const failure = await refusalOf({ ...VALID, deliveryDate: 'sometime in October' });
    expect(failure.details).toHaveProperty('deliveryDate');
  });

  it('refuses a client-supplied status, so an enquiry cannot start anywhere but new', async () => {
    const failure = await refusalOf({ ...VALID, status: 'approved' });
    expect(failure.details).toHaveProperty('status');
  });
});
