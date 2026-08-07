import type { RequestHandler } from './$types';
import { proxyToReference } from '$lib/server/proxy';

// Covers /api/ps, the loaded-model endpoints the model page uses.
const handler: RequestHandler = ({ request, params }) =>
	proxyToReference(request, `/api/${params.path}`);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
