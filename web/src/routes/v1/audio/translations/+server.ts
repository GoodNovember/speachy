import type { RequestHandler } from './$types';
import {
	createTranslationResponse,
	invalidMultipartResponse
} from '$lib/server/transcription-http';
import { getTranslationExecutors, getVadExecutor } from '$lib/server/executors/executor-registry';

export { createTranslationResponse as _translationResponse } from '$lib/server/transcription-http';

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return invalidMultipartResponse();
	}
	return createTranslationResponse(
		form,
		request.signal,
		getTranslationExecutors(),
		undefined,
		getVadExecutor()
	);
};
