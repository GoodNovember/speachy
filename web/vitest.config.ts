import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Server-side unit tests run in plain Node without the SvelteKit plugin, which
// keeps them fast and free of framework setup. That means $lib has to be
// declared here rather than coming from the generated tsconfig.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		testTimeout: 30_000
	}
});
