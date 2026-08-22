import type { RequestHandler } from './$types';
import { apiNotFoundResponse } from '$lib/server/http-not-found';

// Native /api routes are explicit. Keep the compatibility error shape without
// falling through to the Python reference process.
const handler: RequestHandler = () => apiNotFoundResponse();

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
