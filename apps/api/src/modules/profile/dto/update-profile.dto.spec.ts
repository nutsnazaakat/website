import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { RegisterDto } from '../../auth/dto/register.dto';
import { UpdateProfileDto } from './update-profile.dto';

/**
 * `UpdateProfileDto` through the **production** pipe.
 *
 * `VALIDATION_PIPE_OPTIONS` is imported from `app.module.ts` rather than restated, which its own
 * docblock asks for: a locally-built `new ValidationPipe({ whitelist: true })` would assert these
 * decorators against *this file's* configuration, so a dropped `forbidNonWhitelisted` there would leave
 * every refusal below green while the server accepted `role` and quietly ignored it. Three of this
 * file's cases are about fields that are not declared at all, so they are assertions about that option
 * and nothing else.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (metatype: unknown, value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: metatype as never }));

const refusalOf = async (metatype: unknown, value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(metatype, value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

const detailsOf = async (value: unknown): Promise<Record<string, unknown>> =>
  (await refusalOf(UpdateProfileDto, value)).details ?? {};

/** What the profile form sends: both fields, every time. */
const VALID = { name: 'Asha Rao', phone: '9876543210' };

describe('UpdateProfileDto accepts', () => {
  it('the body the form sends', async () => {
    await expect(validate(UpdateProfileDto, VALID)).resolves.toEqual(VALID);
  });

  /** A patch, so one field is a legal request — which is what makes the verb honest. */
  it.each([{ name: 'Asha R Rao' }, { phone: '9812345678' }])('a single field: %o', async (body) => {
    await expect(validate(UpdateProfileDto, body)).resolves.toEqual(body);
  });

  /**
   * An empty patch is legal — both fields are optional — so the service has to cope with a write that
   * sets nothing. `ProfileService.update` counts the patch's keys rather than issuing one, and the
   * reason is measured rather than assumed: `repository.update({ id }, {})` succeeds and bumps
   * `updatedAt`, because `BaseEntity` declares it `@UpdateDateColumn` and TypeORM adds that column to
   * every update expression. An audit trail claiming an edit on a request that changed nothing.
   */
  it('an empty body, which the service must not turn into an empty UPDATE', async () => {
    await expect(validate(UpdateProfileDto, {})).resolves.toEqual({});
  });

  /** The boundary itself is legal: an off-by-one in the bound would refuse a valid name. */
  it('a name exactly as wide as the column', async () => {
    const name = 'A'.repeat(120);
    await expect(validate(UpdateProfileDto, { name })).resolves.toEqual({ name });
  });

  /** All four leading digits `PHONE_REGEX` admits, so the pattern is not narrowed to one of them. */
  it.each(['6012345678', '7012345678', '8012345678', '9876543210'])(
    'the mobile number %s',
    async (phone) => {
      await expect(validate(UpdateProfileDto, { phone })).resolves.toEqual({ phone });
    },
  );
});

describe('UpdateProfileDto refuses', () => {
  /**
   * **The 500-that-should-be-a-400, closed.**
   *
   * `users.name` is `varchar(120)`. Without `@MaxLength(120)` a longer value reaches the driver,
   * Postgres raises SQLSTATE `22001` (*value too long for type character varying(120)*), nothing
   * catches `QueryFailedError`, and the customer is shown **500 Internal server error** with the edit
   * silently not saved and nothing on screen to say which field was at fault. The same defect the
   * `Idempotency-Key` cap closed in Task 9 and the address `label` closed in Task 21.
   */
  it('a name wider than the column, so a long name is a 400 and not a 500', async () => {
    const failure = await refusalOf(UpdateProfileDto, { name: 'A'.repeat(121) });

    expect(failure.getStatus()).toBe(400);
    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.details).toEqual({
      name: ['name must be shorter than or equal to 120 characters'],
    });
  });

  it('a name too short to be one, in the registration form’s own words', async () => {
    await expect(detailsOf({ name: 'A' })).resolves.toEqual({ name: ['Enter your full name'] });
  });

  /**
   * **A blank name is a 400 rather than a 200 that blanks the customer's name.**
   *
   * `'  '` is a *present* two-character string, so `@MinLength(2)` is satisfied by it and every other
   * decorator here passes. Without the `@Transform` that trims before validation the only remaining
   * question is what the service does with it, and both answers are bad: store it and the name renders
   * as padding, trim it and `users.name` — `NOT NULL varchar(120)` with no check constraint — holds
   * `''`, so every future order and delivery note carries a blank name. Delivered by a 200.
   *
   * The task text for this module said `@MinLength(2) @MaxLength(120)` on `name` *"and nothing else on
   * this DTO"*; this case is why there is something else. Note that `RegisterDto` still has the hole —
   * it trims in the service (`auth.service.ts:76`), after validation, so `{ name: '  ' }` registers an
   * account with an empty name.
   */
  it.each(['  ', '\t\n', ' A '])('a name that is blank once trimmed: %j', async (name) => {
    await expect(detailsOf({ name })).resolves.toEqual({ name: ['Enter your full name'] });
  });

  it.each([
    ['too short', '98765'],
    ['a landline prefix', '2212345678'],
    ['eleven digits', '98765432100'],
    ['digits with a country code', '+919876543210'],
    ['spaced', '98765 43210'],
  ])('a phone number that is %s', async (_why, phone) => {
    await expect(detailsOf({ phone })).resolves.toEqual({
      phone: ['Enter a valid 10-digit Indian mobile number'],
    });
  });

  /**
   * **`phone` carries no `@MaxLength(15)` and does not need one**, which this case is the proof of
   * rather than a claim about. `PHONE_REGEX` is `/^[6-9]\d{9}$/` — anchored at both ends — so it admits
   * exactly ten characters and bounds `varchar(15)` by itself. A value that would overflow the column
   * is refused by the pattern, so a second bound beside it would be a weaker restatement of this one.
   */
  it('a phone number wider than its column, by the pattern alone', async () => {
    await expect(detailsOf({ phone: '9'.repeat(16) })).resolves.toEqual({
      phone: ['Enter a valid 10-digit Indian mobile number'],
    });
  });

  it('a name that is not a string at all', async () => {
    await expect(refusalOf(UpdateProfileDto, { name: 42 })).resolves.toBeInstanceOf(DomainError);
  });
});

/**
 * **The three fields this endpoint must not accept, refused by their absence.**
 *
 * Each is enforced by `forbidNonWhitelisted` over a property that is simply not declared, which is a
 * mechanism worth testing precisely because there is no code to read: adding `email?: string` with any
 * decorator on it is the entire change needed to open the hole, and nothing else in the suite would
 * notice. A 400 rather than a silently-stripped field also matters on its own — a client that thought
 * it had changed an email address and was answered 200 would be wrong at a distance.
 */
describe('UpdateProfileDto is not a way to change', () => {
  it.each([
    ['email', { email: 'someone.else@demo.in' }],
    ['role', { role: 'admin' }],
    ['isActive', { isActive: false }],
  ])('%s', async (field, body) => {
    const failure = await refusalOf(UpdateProfileDto, { ...VALID, ...body });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({ [field]: [`property ${field} should not exist`] });
  });

  /** `passwordHash` and `id` for the same reason — a mass assignment is refused, not ignored. */
  it.each(['passwordHash', 'id', 'lastLoginAt', 'createdAt'])('%s', async (field) => {
    const failure = await refusalOf(UpdateProfileDto, { ...VALID, [field]: 'x' });

    expect(failure.details).toEqual({ [field]: [`property ${field} should not exist`] });
  });
});

/**
 * **The wording is `RegisterDto`'s, and this is what keeps it that way.**
 *
 * The same two fields are collected when the account is created, so a customer who mistypes a mobile
 * number has to read the same sentence whichever form they are on. Asserted by validating *both*
 * classes against the same input and comparing what each says about these two fields — which is
 * stronger than a shared constant would be, because it also fails if registration's wording is the one
 * that changes.
 *
 * Inheritance would have been the other way to hold this (`PartialType(PickType(RegisterDto, …))`), and
 * it was not taken: it would import registration's decorators wholesale, so a rule added there for a
 * *new account* — a reserved-name check, say — would silently start refusing an edit to an existing one.
 */
describe('UpdateProfileDto and RegisterDto', () => {
  const registerDetails = async (over: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (
      await refusalOf(RegisterDto, {
        name: 'Asha Rao',
        email: 'b2c@demo.in',
        phone: '9876543210',
        password: 'Password123!',
        isBusiness: false,
        ...over,
      })
    ).details ?? {};

  it.each([
    ['a short name', { name: 'A' }],
    ['a long name', { name: 'A'.repeat(121) }],
    ['a bad phone number', { phone: '98765' }],
  ])('say the same thing about %s', async (_why, body) => {
    const field = Object.keys(body)[0] as string;

    expect((await detailsOf(body))[field]).toEqual((await registerDetails(body))[field]);
  });
});
