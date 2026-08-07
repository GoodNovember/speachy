import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		// *.svelte.ts carries runes, so it goes through the svelte parser too.
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: { parserOptions: { parser: ts.parser } }
	},
	{
		// AudioWorkletGlobalScope, not the window or node globals.
		files: ['**/audio/*-worklet.js'],
		languageOptions: {
			globals: {
				AudioWorkletProcessor: 'readonly',
				registerProcessor: 'readonly',
				sampleRate: 'readonly',
				currentTime: 'readonly',
				currentFrame: 'readonly'
			}
		}
	},
	{
		ignores: ['build/', 'build-server/', '.svelte-kit/', 'node_modules/']
	}
);
