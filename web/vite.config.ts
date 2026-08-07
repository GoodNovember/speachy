import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { realtimeDev } from './vite-plugin-realtime.ts';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),

			// SvelteKit rejects cross-site POSTs carrying form content types, which
			// is exactly how /v1/audio/transcriptions is called. Every non-browser
			// client -- the OpenAI SDK, curl, the ported pytest suite -- sends
			// multipart with no matching Origin and would get a 403.
			//
			// This is safe here because the API authenticates with an Authorization
			// header, never cookies. A cross-site form POST cannot set that header,
			// so there is no ambient authority for CSRF to abuse. If cookie or
			// session auth is ever added, this must be revisited.
			csrf: { checkOrigin: false }
		}),
		realtimeDev()
	]
});
