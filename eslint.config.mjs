import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/**', 'out/**', 'node_modules/**', '.package-stage/**']),
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      eqeqeq: ['error', 'smart'],
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['design/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.browser, sourceType: 'script' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/strict-boolean-expressions': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'electron', '**/main/**', '**/preload/**'] },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', 'require', '__dirname', '__filename'],
    },
  },
  // The approved dependency-free preview shares globals across ordered script files.
  { files: ['design/**/*.js'], rules: { 'no-unused-vars': 'off', 'no-undef': 'off' } },
  prettier,
);
