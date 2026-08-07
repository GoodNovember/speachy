import { defineConfig } from 'vitest/config';

// Server-side unit tests run in plain Node without the SvelteKit plugin, which
// keeps them fast and free of framework setup. Component tests get their own
// config when Phase 1 needs them.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		testTimeout: 10_000
	}
});
