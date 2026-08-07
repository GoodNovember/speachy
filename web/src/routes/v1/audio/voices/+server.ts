import type { RequestHandler } from './$types';
import { listLocalVoices } from '$lib/server/model-catalog';

export const GET: RequestHandler = async () =>
	Response.json({ voices: await listLocalVoices(), object: 'list' });
