import type { RequestHandler } from './$types';
import { APIProxyError } from '$lib/server/errors';
import { AudioDecodeError, decodeAudioUpload } from '$lib/server/audio-decode';
import {
	findExecutorForModel,
	getDiarizationExecutors
} from '$lib/server/executors/executor-registry';
import type { Audio, DiarizationExecutor, DiarizationSegment } from '$lib/server/executors/types';

type AudioDecoder = (file: Blob, signal: AbortSignal) => Promise<Audio>;
type ResponseFormat = 'json' | 'rttm';

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

function rttm(segments: readonly DiarizationSegment[], fileId: string): string {
	return segments
		.map((segment) => {
			const duration = segment.end - segment.start;
			return `SPEAKER ${fileId} 1 ${segment.start.toFixed(3)} ${duration.toFixed(3)} <NA> <NA> ${segment.speaker} <NA> <NA>`;
		})
		.join('\n');
}

export async function _diarizationResponse(
	form: FormData,
	signal: AbortSignal,
	executors: readonly DiarizationExecutor[],
	decode: AudioDecoder = (file, requestSignal) => decodeAudioUpload(file, { signal: requestSignal })
): Promise<Response> {
	const model = form.get('model');
	if (typeof model !== 'string' || model.length === 0) {
		return validationError('model', 'Field required', model);
	}
	const file = form.get('file');
	if (!(file instanceof Blob)) return validationError('file', 'Field required', file);

	const requestedFormat = form.get('response_format');
	const responseFormat: ResponseFormat =
		requestedFormat === null || requestedFormat === ''
			? 'json'
			: (requestedFormat as ResponseFormat);
	if (responseFormat !== 'json' && responseFormat !== 'rttm') {
		return validationError('response_format', "Input should be 'json' or 'rttm'", requestedFormat);
	}
	const requestedNumSpeakers = form.get('num_speakers');
	let numSpeakers: number | undefined;
	if (requestedNumSpeakers !== null && requestedNumSpeakers !== '') {
		if (
			typeof requestedNumSpeakers !== 'string' ||
			!/^\d+$/.test(requestedNumSpeakers) ||
			Number(requestedNumSpeakers) < 1 ||
			!Number.isSafeInteger(Number(requestedNumSpeakers))
		) {
			return validationError(
				'num_speakers',
				'Input should be a positive integer',
				requestedNumSpeakers
			);
		}
		numSpeakers = Number(requestedNumSpeakers);
	}

	if (form.has('known_speaker_names[]') || form.has('known_speaker_references[]')) {
		return Response.json(
			{
				detail:
					'Known-speaker reference mapping is not supported by the SvelteKit diarization endpoint yet'
			},
			{ status: 501 }
		);
	}

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
		const segments = await executor.diarize(
			{ audio, modelId: model, ...(numSpeakers === undefined ? {} : { numSpeakers }) },
			signal
		);
		if (responseFormat === 'rttm') {
			return new Response(rttm(segments, audio.name ?? 'audio'), {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		}
		return Response.json({
			duration: audio.data.length / audio.sampleRate,
			segments
		});
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (workerErrorCode(error) === 'model_not_available') {
			return Response.json({ detail: `Model '${model}' not found` }, { status: 404 });
		}
		throw new APIProxyError('Diarization inference failed', { debug: error });
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return validationError('file', 'Expected multipart form data', null);
	}
	return _diarizationResponse(form, request.signal, getDiarizationExecutors());
};
