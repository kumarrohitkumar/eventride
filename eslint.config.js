import js from '@eslint/js'
import ts from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default ts.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.expo/**', '**/generated/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    rules: {
      // Production hygiene: logging goes through pino, never console (HLD §12).
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-floating-decimal': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // The engine must stay pure (HLD T15): no clock, no randomness, no I/O.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/**/*.test.ts', 'packages/engine/src/testkit.ts'],
    rules: {
      // Date-as-a-type is fine; reading the *clock* or randomness is not.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Engine must be deterministic (HLD T15).' },
        { object: 'Date', property: 'now', message: 'Engine must use snapshot.now (HLD T15).' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'apps/sim/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Expo/Metro/Babel config files are CommonJS Node scripts, not app source: they legitimately
    // use `require` and `module.exports`.
    files: ['**/metro.config.js', '**/babel.config.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-undef': 'off' },
  },
  {
    // NestJS dependency injection resolves constructor params from runtime class references
    // (via emitDecoratorMetadata). Rewriting those to `import type` erases the value the injector
    // needs, so the rule is scoped off here rather than working around it per-file.
    files: ['apps/api/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
)
