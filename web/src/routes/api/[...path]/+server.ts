import type { RequestHandler } from './$types';
import { proxyToReference } from '$lib/server/proxy';

// Covers any remaining Python /api routes. /api/ps is native now and wins as
// the more specific SvelteKit route.
const handler: RequestHandler = ({ request, params }) =>
	proxyToReference(request, `/api/${params.path}`);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
