import type { RequestHandler } from './$types';
import { APIProxyError } from '$lib/server/errors';
import { AudioDecodeError, decodeAudioUpload } from '$lib/server/audio-decode';
import {
	findExecutorForModel,
	getSpeakerEmbeddingExecutors
} from '$lib/server/executors/executor-registry';
import type { Audio, SpeakerEmbeddingExecutor } from '$lib/server/executors/types';

type AudioDecoder = (file: Blob, signal: AbortSignal) => Promise<Audio>;

function validationError(field: string, message: string, input: unknown): Response {
	return Response.json(
		{
			detail: [
				{
					type: 'missing',
					loc: ['body', field],
					msg: message,
					input
				}
			]
		},
		{ status: 422 }
	);
}

function workerErrorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export async function _speakerEmbeddingResponse(
	form: FormData,
	signal: AbortSignal,
	executors: readonly SpeakerEmbeddingExecutor[],
	decode: AudioDecoder = (file, requestSignal) => decodeAudioUpload(file, { signal: requestSignal })
): Promise<Response> {
	const model = form.get('model');
	if (typeof model !== 'string' || model.length === 0) {
		return validationError('model', 'Field required', model);
	}
	const file = form.get('file');
	if (!(file instanceof Blob)) return validationError('file', 'Field required', file);

	const executor = await findExecutorForModel(model, executors);
	if (executor === undefined) {
		return Response.json({ detail: `Model '${model}' not found` }, { status: 404 });
	}

	let audio: Audio;
	try {
		audio = await decode(file, signal);
	} catch (error) {
		if (error instanceof AudioDecodeError) {
			return Response.json({ detail: error.message }, { status: error.status });
		}
		throw error;
	}

	try {
		const embedding = await executor.embed({ audio, modelId: model }, signal);
		return Response.json({
			object: 'list',
			data: [{ object: 'embedding', embedding: Array.from(embedding), index: 0 }],
			model,
			usage: { prompt_tokens: audio.data.length, total_tokens: audio.data.length }
		});
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (workerErrorCode(error) === 'model_not_available') {
			return Response.json({ detail: `Model '${model}' not found` }, { status: 404 });
		}
		throw new APIProxyError('Speaker embedding inference failed', { debug: error });
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return validationError('file', 'Expected multipart form data', null);
	}
	return _speakerEmbeddingResponse(form, request.signal, getSpeakerEmbeddingExecutors());
};
