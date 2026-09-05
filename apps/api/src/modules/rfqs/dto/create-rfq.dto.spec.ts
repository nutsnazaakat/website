import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { CreateRfqDto } from './create-rfq.dto';

/**
 * Validated through the **production** pipe, not a locally-built one — `save-address.dto.spec.ts`'s
 * own reasoning: a hand-rolled `new ValidationPipe({ whitelist: true })` would assert these
 * decorators against this file's own configuration rather than the one the server actually runs,
 * so a dropped `forbidNonWhitelisted` here would leave this suite green while the real pipe
 * accepted what it claims to reject.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: CreateRfqDto as never }));

const refusalOf = async (value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

/** A body `rfqSchema` really sends, with every field at a legal value. */
const VALID = {
  businessName: 'Crumb & Co Bakery',
  contactPerson: 'Priya Menon',
  mobile: '9820098200',
  email: 'priya@crumbandco.example',
  gstin: '29ABCDE1234F1Z5',
  businessType: 'Bakery',
  pincode: '400050',
  lines: [{ productSlug: 'premium-california-almonds', kg: 60 }],
  packaging: 'Vacuum packs (5 kg)',
  frequency: 'Fortnightly',
  notes: 'Festive season ramp-up.',
};

describe('CreateRfqDto', () => {
  it('accepts the body the form sends', async () => {
    await expect(validate(VALID)).resolves.toEqual(VALID);
  });

  it('accepts an enquiry with no GSTIN and no notes', async () => {
    const { gstin, notes, ...rest } = VALID;
    expect({ gstin, notes }).toBeDefined();
    await expect(validate(rest)).resolves.toEqual(rest);
  });

  it('refuses a business name wider than the column, so a long name is a 400 and not a 500', async () => {
    const failure = await refusalOf({ ...VALID, businessName: 'H'.repeat(161) });
    expect(failure.getStatus()).toBe(400);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details).toHaveProperty('businessName');
  });

  it('refuses a malformed mobile number', async () => {
    const failure = await refusalOf({ ...VALID, mobile: '12345' });
    expect(failure.details).toHaveProperty('mobile');
  });

  it('refuses a businessType outside the vocabulary the select actually offers', async () => {
    const failure = await refusalOf({ ...VALID, businessType: 'Something else entirely' });
    expect(failure.details).toHaveProperty('businessType');
  });

  it('refuses a packaging value outside the vocabulary', async () => {
    const failure = await refusalOf({ ...VALID, packaging: 'Whatever box is lying around' });
    expect(failure.details).toHaveProperty('packaging');
  });

  it('refuses a frequency value outside the vocabulary', async () => {
    const failure = await refusalOf({ ...VALID, frequency: 'Whenever' });
    expect(failure.details).toHaveProperty('frequency');
  });

  /** `rfqSchema.lines.min(1)` — an enquiry that names nothing is not an enquiry. */
  it('refuses an empty line list', async () => {
    const failure = await refusalOf({ ...VALID, lines: [] });
    expect(failure.details).toHaveProperty('lines');
  });

  it('refuses a line whose weight is below the form’s own floor', async () => {
    const failure = await refusalOf({
      ...VALID,
      lines: [{ productSlug: 'premium-california-almonds', kg: 0 }],
    });
    // The literal key `"lines.0.kg"` — `validationExceptionFactory` keys a `@ValidateNested`
    // failure by a computed dotted *string*, not a nested path `toHaveProperty` would otherwise
    // read into `details.lines[0].kg`. The array form forces the literal lookup.
    expect(failure.details).toHaveProperty(['lines.0.kg']);
  });

  it('refuses a client-supplied status, so an enquiry cannot start anywhere but new', async () => {
    const failure = await refusalOf({ ...VALID, status: 'approved' });
    expect(failure.details).toHaveProperty('status');
  });
});
