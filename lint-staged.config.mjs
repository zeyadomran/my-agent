export default {
  '*.{ts,tsx,mjs,js}': ['eslint --fix --max-warnings 0', 'prettier --write'],
  '*.{json,md,yml,yaml,html,css,svg}': 'prettier --write',
};
