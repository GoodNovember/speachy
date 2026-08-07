import type { Handle } from '@sveltejs/kit';
import { bootstrap } from '$lib/server/bootstrap';

const runtime = bootstrap();

// API-key verification and CORS land here in Phase 2, replacing the equivalent
// wiring in the Python create_app().
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.config = runtime.config;
	return resolve(event);
};
