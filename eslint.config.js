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
      'jsdoc/check-param-names': [ 'error', { checkDestructured: false }],
      'jsdoc/require-param': [ 'error', { checkDestructured: false }],
      'jsdoc/require-returns': 'error',
      'jsdoc/require-jsdoc': 'error',
    },
  },
  {
    rules: {
      // This project is a Node.js script
      'import/no-nodejs-modules': 'off',
      'ts/naming-convention': 'off',
    },
  },
  {
    ignores: [ 'dist', '.cache' ],
  },
], { disableJest: true });
