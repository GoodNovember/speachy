import type { RequestHandler } from './$types';
import { proxyToReference } from '$lib/server/proxy';

// Phase 1: forwards to the Python reference. In Phase 2 these paths get real
// handlers one at a time, and the UI does not change.
const handler: RequestHandler = ({ request, params }) =>
	proxyToReference(request, `/v1/${params.path}`);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
