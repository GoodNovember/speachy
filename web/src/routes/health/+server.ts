import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => Response.json({ message: 'OK' });
