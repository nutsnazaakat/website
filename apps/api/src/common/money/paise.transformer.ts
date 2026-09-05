import { Column, type ColumnOptions, type ValueTransformer } from 'typeorm';

/**
 * Maps a Postgres `bigint` to a JavaScript `bigint`.
 *
 * The `pg` driver returns `bigint` columns as strings, because a 64-bit integer does not fit a
 * JavaScript number. Without this transformer every money field would arrive as a string and
 * arithmetic would silently concatenate: `'100' + '50'` is `'10050'`, not `150`.
 *
 * `satisfies` rather than a `: ValueTransformer` annotation. TypeORM declares `to`/`from` as
 * `(value: any) => any` using method shorthand, which TypeScript compares bivariantly — so
 * annotating with the interface widens the exported type and `paiseTransformer.to(123)` or
 * `.to('abc')` would typecheck at every call site. `satisfies` still validates structural
 * conformance (a typo'd method name fails) while keeping the narrow signatures for callers,
 * which is the whole point of the file.
 */
export const paiseTransformer = {
  to: (value?: bigint | null): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value?: string | null): bigint | null | undefined =>
    value === null || value === undefined ? value : BigInt(value),
} satisfies ValueTransformer;

/**
 * Everything a money column needs, minus the two things it must not be allowed to change.
 *
 * `Omit`ting `type` and `transformer` makes overriding them a compile error. The previous
 * spread-an-object approach could not do that: `@Column({ ...paiseColumn, type: 'integer' })`
 * typechecked happily and silently dropped the invariant, which for a money column means the
 * driver hands back a string and totals start concatenating.
 */
export type PaiseColumnOptions = Omit<ColumnOptions, 'type' | 'transformer'>;

/**
 * Declares a money column. Use this for every monetary field — never a bare
 * `@Column({ type: 'bigint' })`, which the eslint config rejects for exactly that reason.
 *
 *   @PaiseColumn() pricePaise: bigint;
 *   @PaiseColumn({ nullable: true }) pricePerKgPaise: bigint | null;
 *   @PaiseColumn({ default: 0 }) discountPaise: bigint;
 */
export function PaiseColumn(options: PaiseColumnOptions = {}): PropertyDecorator {
  // `type` and `transformer` come last so they win at runtime even if a caller defeats the
  // compile-time guard through an `as` cast.
  return Column({ ...options, type: 'bigint', transformer: paiseTransformer });
}
