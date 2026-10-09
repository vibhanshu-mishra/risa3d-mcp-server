// Place this file next to the JavaScript/TypeScript project's package.json.
// If an ESLint config already exists, update it rather than overwriting it.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
  ignores: ['**/dist/**', '**/build/**', '**/coverage/**'],
  files: ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
  extends: [js.configs.recommended, tseslint.configs.recommended],
});
