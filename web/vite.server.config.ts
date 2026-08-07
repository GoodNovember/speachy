import { defineConfig } from 'vite';

// Builds the standalone production server that owns the HTTP listener and the
// realtime WebSocket, and mounts SvelteKit's handler as the fallback route.
export default defineConfig({
	build: {
		ssr: 'src/server-entry.ts',
		outDir: 'build-server',
		emptyOutDir: true,
		target: 'node22',
		minify: false,
		rollupOptions: {
			output: { format: 'es', entryFileNames: 'server-entry.js' }
		}
	}
});
