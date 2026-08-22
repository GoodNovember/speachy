import type { RequestHandler } from './$types';
import { apiNotFoundResponse } from '$lib/server/http-not-found';

// The Phase 1 HTTP proxy is intentionally gone. Unknown compatibility paths
// must fail here rather than silently reaching around the native API surface.
const handler: RequestHandler = () => apiNotFoundResponse();

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
