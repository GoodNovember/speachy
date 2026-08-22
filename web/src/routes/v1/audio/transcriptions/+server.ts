import type { RequestHandler } from './$types';
import {
	createTranscriptionResponse,
	invalidMultipartResponse
} from '$lib/server/transcription-http';
import { getTranscriptionExecutors } from '$lib/server/executors/executor-registry';

export { createTranscriptionResponse as _transcriptionResponse } from '$lib/server/transcription-http';

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return invalidMultipartResponse();
	}
	return createTranscriptionResponse(form, request.signal, getTranscriptionExecutors());
};
