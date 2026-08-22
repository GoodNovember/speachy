import type { RequestHandler } from './$types';
import { getSpeechExecutors } from '$lib/server/executors/executor-registry';
import { createSpeechResponse, invalidJsonResponse } from '$lib/server/speech-http';

export { createSpeechResponse as _speechResponse } from '$lib/server/speech-http';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return invalidJsonResponse();
	}
	return createSpeechResponse(body, request.signal, getSpeechExecutors());
};
