import type { RequestHandler } from './$types';
import { listLocalAudioModels } from '$lib/server/model-catalog';

export const GET: RequestHandler = async () =>
	Response.json({ models: await listLocalAudioModels(), object: 'list' });
