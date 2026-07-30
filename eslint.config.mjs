import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['coverage/', 'dist/', 'node_modules/'],
	},
	eslint.configs.recommended,
	tseslint.configs.recommended,
	eslintConfigPrettier,
);
