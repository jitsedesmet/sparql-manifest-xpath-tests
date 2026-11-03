import config from '@rubensworks/eslint-config';

export default config([
  {
    files: [ '**/*.ts' ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [ './tsconfig.json' ],
      },
    },
    rules: {
      // Node.js type stripping does not support angle-bracket assertions
      'ts/consistent-type-assertions': [ 'error', { assertionStyle: 'as' }],
      // Destructured parameters are described by their type
      'jsdoc/check-param-names': [ 'warn', { checkDestructured: false }],
    },
  },
  {
    rules: {
      'unicorn/no-useless-undefined': [ 'error', { checkArguments: false }],
      'import/extensions': 'off',
      // This project is a Node.js script
      'import/no-nodejs-modules': 'off',

      'unicorn/consistent-destructuring': 'off',
      'unicorn/no-array-callback-reference': 'off',

      'ts/naming-convention': 'off',
      'ts/no-unsafe-return': 'off',
      'ts/no-unsafe-argument': 'off',
      'ts/no-unsafe-assignment': 'off',
    },
  },
  {
    ignores: [ 'dist', '.cache' ],
  },
], { disableJest: true });
