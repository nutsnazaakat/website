import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../../app.module';
import { DomainError } from '../../../common/errors/domain-error';
import { CreateCategoryDto } from './save-category.dto';
import { CreateProductDto, UpdateProductDto } from './save-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './save-variant.dto';

/**
 * The admin catalogue DTOs, validated through the **production** pipe.
 *
 * `VALIDATION_PIPE_OPTIONS` is imported from `app.module.ts` rather than restated, which is what its
 * own docblock asks for: a locally-built `new ValidationPipe({ whitelist: true })` would assert these
 * decorators against *this file's* configuration, so a dropped `forbidNonWhitelisted` there would
 * leave every case below green while the server accepted what they claim it rejects.
 *
 * The cases are chosen for one property: each is a refusal that would otherwise be a **500** or a
 * silent write, not a decorator inventory. `save-address.dto.spec.ts` sets that precedent.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);

const validate = (metatype: unknown, value: unknown): Promise<unknown> =>
  Promise.resolve(pipe.transform(value, { type: 'body', metatype: metatype as never }));

const refusalOf = async (metatype: unknown, value: unknown): Promise<DomainError> => {
  const failure: unknown = await validate(metatype, value).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(DomainError);
  return failure as DomainError;
};

const PRODUCT = {
  name: 'Premium California Almonds',
  slug: 'premium-california-almonds',
  categoryId: '5f9d1a3e-1c3b-4a0e-9f2a-8b7c6d5e4f30',
  subtitle: 'Crunchy, uniform kernels for daily snacking.',
  description: 'Graded almond kernels from California.',
  origin: 'California, USA',
  grade: 'Independence',
  processing: 'Cleaned, sorted and machine graded',
  shelfLife: '9 months from packing',
  storage: 'Store in a cool, dry place.',
  ingredients: 'Almonds',
  hsn: '0802',
  gstRate: 5,
};

const VARIANT = {
  sku: 'PCA-1KG',
  size: '1kg',
  grams: 1000,
  channel: 'retail',
  price: 899,
  mrp: 1045,
};

describe('CreateProductDto', () => {
  it('accepts brief §30’s field list', async () => {
    await expect(validate(CreateProductDto, PRODUCT)).resolves.toEqual(PRODUCT);
  });

  /**
   * A slug is a URL. `@IsString()` alone would accept `Premium Almonds`, store it, and then 404 on
   * the storefront under whatever the client happened to percent-encode it as — a broken product
   * page with nothing anywhere saying why.
   */
  it.each([
    ['a space', 'Premium Almonds'],
    ['uppercase', 'Premium-Almonds'],
    ['a leading hyphen', '-almonds'],
    ['a double hyphen', 'premium--almonds'],
    ['an underscore', 'premium_almonds'],
  ])('refuses a slug with %s', async (_label, slug) => {
    const failure = await refusalOf(CreateProductDto, { ...PRODUCT, slug });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({
      slug: ['slug must be lowercase letters, digits and single hyphens'],
    });
  });

  /**
   * **The 500-that-should-be-a-400.** `products.gstRate` is `numeric(5,2)`, and a rate with three
   * decimal places is a data-entry mistake Postgres would silently round — leaving the stored
   * catalogue disagreeing with what an admin typed, which is the exact failure `toPaise` refuses to
   * commit for money. `maxDecimalPlaces: 2` matches the column's scale.
   */
  it('refuses a GST rate finer than the column’s scale', async () => {
    const failure = await refusalOf(CreateProductDto, { ...PRODUCT, gstRate: 5.125 });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details?.gstRate).toBeDefined();
  });

  /**
   * Mass assignment, spec §13. `isPublished` is deliberately not on this DTO — publishing is
   * `POST /admin/products/:id/publish`, so that the audit trail has a `product.publish` row behind
   * every live listing — and `forbidNonWhitelisted` is what makes its absence a refusal rather than
   * a field quietly ignored.
   */
  it('refuses isPublished in the body, so a create cannot publish', async () => {
    const failure = await refusalOf(CreateProductDto, { ...PRODUCT, isPublished: true });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({ isPublished: ['property isPublished should not exist'] });
  });

  /**
   * The same guard closes the audit trail's own hole: an `actorUserId` in the body is refused
   * outright, on top of the controllers assigning it *after* the DTO spread.
   */
  it('refuses actorUserId in the body', async () => {
    const failure = await refusalOf(CreateProductDto, { ...PRODUCT, actorUserId: 'someone-else' });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({ actorUserId: ['property actorUserId should not exist'] });
  });

  /** `@ValidateNested` + `@Type` together, or nested rules are silently skipped. */
  it('validates inside seo rather than accepting any object', async () => {
    await expect(
      validate(CreateProductDto, { ...PRODUCT, seo: { title: 'Almonds' } }),
    ).resolves.toMatchObject({ seo: { title: 'Almonds' } });

    const failure = await refusalOf(CreateProductDto, { ...PRODUCT, seo: { titel: 'typo' } });
    expect(failure.details).toEqual({ 'seo.titel': ['property titel should not exist'] });
  });
});

describe('UpdateProductDto', () => {
  it('accepts a single field, because an omitted field means leave unchanged', async () => {
    await expect(validate(UpdateProductDto, { name: 'Renamed' })).resolves.toEqual({
      name: 'Renamed',
    });
  });

  /**
   * **Optional and lenient are different things.** `PartialType` adds `@IsOptional()` and copies the
   * rest of the metadata, so a field that *is* sent still has to satisfy every inherited rule — a
   * PATCH cannot slip past a check a POST enforces.
   */
  it('still enforces the slug rule on a slug that is sent', async () => {
    const failure = await refusalOf(UpdateProductDto, { slug: 'Not A Slug' });

    expect(failure.details).toEqual({
      slug: ['slug must be lowercase letters, digits and single hyphens'],
    });
  });
});

describe('CreateVariantDto', () => {
  it('accepts a variant body with the optional fields omitted', async () => {
    await expect(validate(CreateVariantDto, VARIANT)).resolves.toEqual(VARIANT);
  });

  /**
   * **The other 500-that-should-be-a-400, and this one is `toPaise`'s.** `toPaise` *throws* on
   * sub-paise input rather than rounding — deliberately, because "silently storing ₹12.35 would make
   * the stored catalogue disagree with what an admin typed" — and an unguarded `RangeError` from a
   * service is an internal error. `maxDecimalPlaces: 2` turns it into a named field refusal.
   */
  it.each(['price', 'mrp'])('refuses a sub-paise %s, so toPaise cannot throw', async (field) => {
    const failure = await refusalOf(CreateVariantDto, { ...VARIANT, [field]: 12.345 });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details?.[field]).toBeDefined();
  });

  it('refuses a channel outside the shared union', async () => {
    const failure = await refusalOf(CreateVariantDto, { ...VARIANT, channel: 'wholesale' });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details?.channel).toBeDefined();
  });

  /**
   * `onHand` is not settable, and this is the guard behind that sentence.
   * `SUM(inventory_transactions.delta) = inventory.onHand` per variant is an invariant
   * `schema-invariants.integration.spec.ts` asserts, and an opening figure written into the column
   * with no ledger row behind it would break it on the first variant anyone created.
   */
  it('refuses onHand in the body, so opening stock cannot bypass the ledger', async () => {
    const failure = await refusalOf(CreateVariantDto, { ...VARIANT, onHand: 120 });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details).toEqual({ onHand: ['property onHand should not exist'] });
  });
});

describe('UpdateVariantDto', () => {
  /**
   * `lowStockThreshold` belongs to the `Inventory` row, not the variant. Letting a variant PATCH
   * reach across would put a second writer on a table whose whole design is that `InventoryService`
   * is the only one — the `SUM(delta) == onHand` invariant depends on it.
   */
  it('refuses lowStockThreshold, which belongs to the inventory row', async () => {
    const failure = await refusalOf(UpdateVariantDto, { lowStockThreshold: 5 });

    expect(failure.details).toEqual({
      lowStockThreshold: ['property lowStockThreshold should not exist'],
    });
  });

  it('accepts a lone isActive, which is how a pack is withdrawn', async () => {
    await expect(validate(UpdateVariantDto, { isActive: false })).resolves.toEqual({
      isActive: false,
    });
  });
});

describe('CreateCategoryDto', () => {
  const CATEGORY = {
    slug: 'almonds',
    name: 'Almonds',
    image: 'https://images.example.com/almonds.jpg',
    blurb: 'Badam, graded and crisp',
    description: 'Graded almond kernels.',
  };

  it('accepts a category body with the optional fields omitted', async () => {
    await expect(validate(CreateCategoryDto, CATEGORY)).resolves.toEqual(CATEGORY);
  });

  it('applies the same slug rule as a product', async () => {
    const failure = await refusalOf(CreateCategoryDto, { ...CATEGORY, slug: 'Dry Fruits' });

    expect(failure.details).toEqual({
      slug: ['slug must be lowercase letters, digits and single hyphens'],
    });
  });

  /**
   * `categories.image` is `varchar(500)`. Without the bound the value reaches the driver, Postgres
   * raises SQLSTATE 22001, nothing catches a `QueryFailedError`, and the answer is a 500 with the
   * category silently not saved — `save-address.dto.spec.ts` closed the identical hole on `label`.
   */
  it('refuses an image url wider than the column', async () => {
    const failure = await refusalOf(CreateCategoryDto, {
      ...CATEGORY,
      image: `https://x.example/${'a'.repeat(500)}`,
    });

    expect(failure.getStatus()).toBe(400);
    expect(failure.details?.image).toBeDefined();
  });
});
