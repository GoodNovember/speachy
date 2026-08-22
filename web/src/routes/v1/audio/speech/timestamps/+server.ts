import type { RequestHandler } from './$types';
import { AudioDecodeError, decodeAudioUpload } from '$lib/server/audio-decode';
import { APIProxyError } from '$lib/server/errors';
import { getVadExecutor } from '$lib/server/executors/executor-registry';
import { SILERO_SAMPLE_RATE, SILERO_VAD_MODEL_ID } from '$lib/server/executors/silero-vad';
import type { Audio, VadExecutor, VadOptions } from '$lib/server/executors/types';

type AudioDecoder = (file: Blob, signal: AbortSignal) => Promise<Audio>;
type ParsedNumber = { ok: true; value: number } | { ok: false; response: Response };

function validationError(field: string, message: string, input: unknown): Response {
	return Response.json(
		{
			detail: [{ type: 'missing', loc: ['body', field], msg: message, input }]
		},
		{ status: 422 }
	);
}

function numberField(
	form: FormData,
	field: string,
	fallback: number,
	options: { maximum?: number; integer?: boolean } = {}
): ParsedNumber {
	const input = form.get(field);
	if (input === null || input === '') return { ok: true, value: fallback };
	const value = typeof input === 'string' ? Number(input) : Number.NaN;
	if (
		!Number.isFinite(value) ||
		value < 0 ||
		(options.maximum !== undefined && value > options.maximum) ||
		(options.integer === true && !Number.isInteger(value))
	) {
		return {
			ok: false,
			response: validationError(field, 'Input should be a valid non-negative number', input)
		};
	}
	return { ok: true, value };
}

export async function _vadResponse(
	form: FormData,
	signal: AbortSignal,
	executor: VadExecutor,
	decode: AudioDecoder = (file, requestSignal) => decodeAudioUpload(file, { signal: requestSignal })
): Promise<Response> {
	const modelInput = form.get('model');
	const model =
		modelInput === null || modelInput === ''
			? SILERO_VAD_MODEL_ID
			: typeof modelInput === 'string'
				? modelInput
				: '';
	if (!(await executor.canHandle(model))) {
		return Response.json({ detail: `Model '${model}' not found` }, { status: 404 });
	}

	const file = form.get('file');
	if (!(file instanceof Blob)) return validationError('file', 'Field required', file);
	const threshold = numberField(form, 'threshold', 0.75, { maximum: 1 });
	if (!threshold.ok) return threshold.response;
	const negativeThreshold = form.has('neg_threshold')
		? numberField(form, 'neg_threshold', 0)
		: ({ ok: true, value: undefined } as const);
	if (!negativeThreshold.ok) return negativeThreshold.response;
	const minSpeechDuration = numberField(form, 'min_speech_duration_ms', 0, { integer: true });
	if (!minSpeechDuration.ok) return minSpeechDuration.response;
	const maxSpeechDuration = numberField(form, 'max_speech_duration_s', Number.POSITIVE_INFINITY);
	if (!maxSpeechDuration.ok) return maxSpeechDuration.response;
	const minSilenceDuration = numberField(form, 'min_silence_duration_ms', 1000, {
		integer: true
	});
	if (!minSilenceDuration.ok) return minSilenceDuration.response;
	const speechPad = numberField(form, 'speech_pad_ms', 0, { integer: true });
	if (!speechPad.ok) return speechPad.response;

	let audio: Audio;
	try {
		audio = await decode(file, signal);
	} catch (error) {
		if (error instanceof AudioDecodeError) {
			return Response.json({ detail: error.message }, { status: error.status });
		}
		throw error;
	}

	const vadOptions: VadOptions = {
		threshold: threshold.value,
		negThreshold: negativeThreshold.value,
		minSpeechDurationMs: minSpeechDuration.value,
		maxSpeechDurationS: maxSpeechDuration.value,
		minSilenceDurationMs: minSilenceDuration.value,
		speechPadMs: speechPad.value
	};
	try {
		const timestamps = await executor.detectSpeech({ audio, modelId: model, vadOptions }, signal);
		const samplesPerMillisecond = SILERO_SAMPLE_RATE / 1000;
		return Response.json(
			timestamps.map(({ start, end }) => ({
				start: Math.floor(start / samplesPerMillisecond),
				end: Math.floor(end / samplesPerMillisecond)
			}))
		);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		throw new APIProxyError('Voice activity detection failed', { debug: error });
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return validationError('file', 'Expected multipart form data', null);
	}
	return _vadResponse(form, request.signal, getVadExecutor());
};
