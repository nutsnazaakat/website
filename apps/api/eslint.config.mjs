import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Type-aware linting is scoped to TypeScript sources.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Root-level tooling configs (jest.config.ts and friends) sit outside tsconfig's
        // `include`, and cannot simply be added to it because `rootDir` is `./src` — tsc
        // rejects an included file above its rootDir. `allowDefaultProject` lets them be
        // linted without belonging to a project.
        projectService: {
          allowDefaultProject: ['*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // `error`, unlike both reference repos where it is `off`. New code has no legacy to
      // grandfather, and `any` in a service handling money or authorization is how type safety
      // silently stops helping.
      //
      // Be honest about the limit: this flags only the literal `any` spelling. It says nothing
      // about `as unknown as X`, which discards structural checking just as completely and is
      // harder to grep for and harder to review. House convention: where a runtime shape check
      // already exists, write a named type predicate (`function isX(v: unknown): v is X`) and let
      // the compiler narrow, rather than asserting past it with a double cast.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',

      /**
       * Every syntactic guard in this config lives in this one `no-restricted-syntax` entry.
       *
       * **Never add a second `'no-restricted-syntax'` key.** ESLint replaces a rule's options
       * wholesale rather than merging them, so a later key silently disables every selector in the
       * earlier one. Add a new `{ selector, message }` object to the array below instead.
       *
       * Each guard exists because the defect it prevents type-checks cleanly, so the compiler
       * cannot be the control and a comment asking people not to do it is not one either.
       */
      'no-restricted-syntax': [
        'error',
        /**
         * Money columns must go through `PaiseColumn`, never a bare `@Column({ type: 'bigint' })`.
         *
         * Without the transformer, `pg` hands a bigint column back as a *string*, and totals
         * silently concatenate — `'100' + '50'` is `'10050'`. That is a wrong-invoice bug no type
         * error catches, so it is worth a syntactic guard, in the same spirit as this config
         * already hard-erroring on bare `any`.
         */
        {
          selector:
            "CallExpression[callee.name='Column'] Property[key.name='type'][value.value='bigint']",
          message:
            "Use @PaiseColumn() from common/money/paise.transformer instead of a bare @Column({ type: 'bigint' }) — without the transformer, money arrives as a string and arithmetic concatenates.",
        },
        /**
         * `soldOut` has exactly one derivation, and it is `variantSoldOut` / `productSoldOut` in
         * `@nutwala/shared`. Spec §10.1.
         *
         * TypeScript enforces that a wire `Variant.soldOut` is *present*, never that its value
         * agrees with `available`. So a second inline `available === 0` in a new mapper compiles
         * cleanly and ships a listing that says "in stock" beside a product page that says
         * "sold out". This turns that into a build failure.
         *
         * The discriminating signal is the **literal 0 or 1 on the other side**. Comparing
         * `available` against zero is asking "is this sold out?", which has one right answer and
         * one place to get it. Comparing it against a quantity — `available < line.qty`,
         * `available >= requestedQty`, `available < lowStockThreshold` — is a different question
         * (can this order be filled? should this warn?) that cart validation and the admin stock
         * view legitimately need, and those are deliberately *not* flagged. A guard that has to be
         * suppressed constantly gets deleted, so it is anchored narrowly on purpose.
         *
         * The three operand spellings are all covered: a bare local or parameter
         * (`left.name`), a member access (`left.property.name`), and an optional-chained member
         * access (`left.expression.property.name` — `?.` wraps the member expression in a
         * `ChainExpression`, which is the likeliest spelling of all given that a variant's
         * `inventory` relation is nullable).
         *
         * Known residual gaps, stated rather than hidden: a computed access
         * (`variant['available'] === 0`), and arithmetic on the compared side
         * (`inv.onHand - inv.reserved > 0`). Both are reachable and neither is idiomatic; catching
         * them would mean flagging every `> 0` in the file.
         */
        {
          selector:
            'BinaryExpression[operator=/^(===|!==|==|!=|<=|>=|<|>)$/]' +
            ":matches([left.name='available'], [left.property.name='available'], [left.expression.property.name='available']," +
            " [right.name='available'], [right.property.name='available'], [right.expression.property.name='available'])" +
            ':matches([left.value=0], [left.value=1], [right.value=0], [right.value=1])',
          message:
            "Do not derive availability inline. Import variantSoldOut / productSoldOut from '@nutwala/shared' — spec §10.1 requires one derivation, because a second one compiles cleanly and ships a flag that disagrees with the first.",
        },
        /**
         * The truthiness spelling of the same mistake, and worse than the comparison forms: `!0` is
         * `true` but `!(-1)` is `false`, so `!available` reports a negative figure as *in stock*.
         * Failing open on availability oversells. `variantSoldOut`'s `<= 0` is the whole point.
         */
        {
          selector:
            "UnaryExpression[operator='!']" +
            ":matches([argument.name='available'], [argument.property.name='available'], [argument.expression.property.name='available'])",
          message:
            "Do not derive availability inline, and never by truthiness — `!available` reads a negative figure as in stock. Import variantSoldOut / productSoldOut from '@nutwala/shared' (spec §10.1).",
        },
      ],
    },
  },
  // The helper itself is where the canonical `type: 'bigint'` legitimately lives. This switches the
  // whole rule off, so the availability selectors are inert here too — accepted, because a money
  // transformer has no business deriving availability, and re-listing them would duplicate them.
  {
    files: ['src/common/money/paise.transformer.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  // This config is plain ESM and needs no type-aware rules.
  { files: ['eslint.config.mjs'], ...tseslint.configs.disableTypeChecked },
  prettier,
);
