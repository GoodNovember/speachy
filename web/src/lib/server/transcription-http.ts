import { AudioDecodeError, decodeAudioUpload } from './audio-decode.ts';
import { APIProxyError } from './errors.ts';
import { findExecutorForModel } from './executors/executor-registry.ts';
import { SILERO_VAD_MODEL_ID } from './executors/silero-vad.ts';
import type {
	Audio,
	ResponseFormat,
	TimestampGranularity,
	Transcription,
	TranscriptionExecutor,
	TranscriptionRequest,
	TranslationRequest,
	VadExecutor,
	VadOptions
} from './executors/types.ts';
import { formatAsSse } from './text-utils.ts';

type AudioDecoder = (file: Blob, signal: AbortSignal) => Promise<Audio>;
type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

const RESPONSE_FORMATS: readonly ResponseFormat[] = ['json', 'text', 'verbose_json', 'srt', 'vtt'];
const TIMESTAMP_COMBINATIONS = new Set(['segment', 'word', 'word,segment', 'segment,word']);

// This matches the Python route's faster-whisper defaults.
const DEFAULT_VAD_OPTIONS: VadOptions = {
	threshold: 0.5,
	minSpeechDurationMs: 0,
	maxSpeechDurationS: 30,
	minSilenceDurationMs: 160,
	speechPadMs: 400
};

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

function requiredString(form: FormData, field: string): Parsed<string> {
	const value = form.get(field);
	if (typeof value !== 'string' || value.length === 0) {
		return { ok: false, response: validationError(field, 'Field required', value) };
	}
	return { ok: true, value };
}

function requiredFile(form: FormData): Parsed<Blob> {
	const value = form.get('file');
	if (!(value instanceof Blob)) {
		return { ok: false, response: validationError('file', 'Field required', value) };
	}
	return { ok: true, value };
}

function responseFormat(form: FormData): Parsed<ResponseFormat> {
	const value = form.get('response_format');
	if (value === null || value === '') return { ok: true, value: 'json' };
	if (typeof value !== 'string' || !RESPONSE_FORMATS.includes(value as ResponseFormat)) {
		return {
			ok: false,
			response: validationError(
				'response_format',
				"Input should be 'json', 'text', 'verbose_json', 'srt' or 'vtt'",
				value
			)
		};
	}
	return { ok: true, value: value as ResponseFormat };
}

function numberField(form: FormData, field: string, fallback: number): Parsed<number> {
	const value = form.get(field);
	if (value === null || value === '') return { ok: true, value: fallback };
	const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) {
		return {
			ok: false,
			response: validationError(field, 'Input should be a valid number', value)
		};
	}
	return { ok: true, value: parsed };
}

function booleanField(form: FormData, field: string, fallback: boolean): Parsed<boolean> {
	const value = form.get(field);
	if (value === null) return { ok: true, value: fallback };
	if (typeof value === 'string') {
		const normalized = value.toLowerCase();
		if (['true', '1', 'on', 'yes'].includes(normalized)) return { ok: true, value: true };
		if (['false', '0', 'off', 'no'].includes(normalized)) return { ok: true, value: false };
	}
	return {
		ok: false,
		response: validationError(field, 'Input should be a valid boolean', value)
	};
}

function optionalString(form: FormData, field: string): string | undefined {
	const value = form.get(field);
	return typeof value === 'string' ? value : undefined;
}

function timestampGranularities(form: FormData): Parsed<TimestampGranularity[]> {
	const values = form.getAll('timestamp_granularities[]');
	if (values.length === 0) return { ok: true, value: ['segment'] };
	if (
		values.some((value) => value !== 'segment' && value !== 'word') ||
		!TIMESTAMP_COMBINATIONS.has(values.join(','))
	) {
		return {
			ok: false,
			response: validationError(
				'timestamp_granularities[]',
				"Input should contain 'segment', 'word', or both once",
				values
			)
		};
	}
	return { ok: true, value: values as TimestampGranularity[] };
}

function workerErrorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function audioSegments(audio: Audio): [{ start: number; end: number }] {
	return [{ start: 0, end: audio.data.length }];
}

async function detectSpeechSegments(
	audio: Audio,
	signal: AbortSignal,
	vadExecutor?: VadExecutor
): Promise<{ start: number; end: number }[]> {
	if (vadExecutor === undefined) return audioSegments(audio);
	return vadExecutor.detectSpeech(
		{
			audio,
			modelId: SILERO_VAD_MODEL_ID,
			vadOptions: DEFAULT_VAD_OPTIONS
		},
		signal
	);
}

function inferenceResponse(result: Transcription, format: ResponseFormat): Response {
	switch (format) {
		case 'text':
		case 'srt':
			return new Response(result.text, {
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			});
		case 'vtt':
			return new Response(result.text, {
				headers: { 'content-type': 'text/vtt; charset=utf-8' }
			});
		case 'verbose_json':
			return Response.json({
				...result,
				segments: result.segments ?? null,
				words: result.words ?? null
			});
		case 'json':
			return Response.json({ text: result.text });
	}
}

function streamResponse(
	executor: TranscriptionExecutor,
	request: TranscriptionRequest,
	signal: AbortSignal
): Response {
	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort(signal.reason);
	if (signal.aborted) forwardAbort();
	else signal.addEventListener('abort', forwardAbort, { once: true });
	const iterator = executor.transcribeStream(request, controller.signal)[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	let finished = false;
	const finish = (): void => {
		if (finished) return;
		finished = true;
		signal.removeEventListener('abort', forwardAbort);
	};

	const body = new ReadableStream<Uint8Array>({
		async pull(streamController) {
			try {
				const next = await iterator.next();
				if (next.done) {
					finish();
					streamController.close();
					return;
				}
				const event =
					next.value.type === 'delta'
						? { type: 'transcript.text.delta', delta: next.value.delta }
						: { type: 'transcript.text.done', text: '' };
				streamController.enqueue(encoder.encode(formatAsSse(JSON.stringify(event))));
			} catch (error) {
				finish();
				streamController.error(
					controller.signal.aborted
						? controller.signal.reason
						: new APIProxyError('Transcription inference failed', { debug: error })
				);
			}
		},
		async cancel(reason) {
			finish();
			controller.abort(reason ?? new Error('Transcription response stream cancelled'));
			await iterator.return?.();
		}
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache'
		}
	});
}

async function decode(
	file: Blob,
	signal: AbortSignal,
	audioDecoder: AudioDecoder
): Promise<Parsed<Audio>> {
	try {
		return { ok: true, value: await audioDecoder(file, signal) };
	} catch (error) {
		if (error instanceof AudioDecodeError) {
			return {
				ok: false,
				response: Response.json({ detail: error.message }, { status: error.status })
			};
		}
		throw error;
	}
}

export async function createTranscriptionResponse(
	form: FormData,
	signal: AbortSignal,
	executors: readonly TranscriptionExecutor[],
	audioDecoder: AudioDecoder = (file, requestSignal) =>
		decodeAudioUpload(file, { signal: requestSignal }),
	vadExecutor?: VadExecutor
): Promise<Response> {
	const model = requiredString(form, 'model');
	if (!model.ok) return model.response;
	const file = requiredFile(form);
	if (!file.ok) return file.response;
	const format = responseFormat(form);
	if (!format.ok) return format.response;
	const temperature = numberField(form, 'temperature', 0);
	if (!temperature.ok) return temperature.response;
	const granularities = timestampGranularities(form);
	if (!granularities.ok) return granularities.response;
	const streaming = booleanField(form, 'stream', false);
	if (!streaming.ok) return streaming.response;
	const withoutTimestamps = booleanField(form, 'without_timestamps', true);
	if (!withoutTimestamps.ok) return withoutTimestamps.response;

	const executor = await findExecutorForModel(model.value, executors);
	if (executor === undefined) {
		return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
	}
	const decoded = await decode(file.value, signal, audioDecoder);
	if (!decoded.ok) return decoded.response;
	const speechSegments = await detectSpeechSegments(decoded.value, signal, vadExecutor);
	const request: TranscriptionRequest = {
		audio: decoded.value,
		model: model.value,
		language: optionalString(form, 'language'),
		prompt: optionalString(form, 'prompt'),
		responseFormat: format.value,
		temperature: temperature.value,
		timestampGranularities: granularities.value,
		speechSegments,
		vadOptions: DEFAULT_VAD_OPTIONS,
		hotwords: optionalString(form, 'hotwords'),
		withoutTimestamps: withoutTimestamps.value
	};
	if (streaming.value) return streamResponse(executor, request, signal);

	try {
		return inferenceResponse(await executor.transcribe(request, signal), format.value);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (workerErrorCode(error) === 'model_not_available') {
			return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
		}
		throw new APIProxyError('Transcription inference failed', { debug: error });
	}
}

export async function createTranslationResponse(
	form: FormData,
	signal: AbortSignal,
	executors: readonly TranscriptionExecutor[],
	audioDecoder: AudioDecoder = (file, requestSignal) =>
		decodeAudioUpload(file, { signal: requestSignal }),
	vadExecutor?: VadExecutor
): Promise<Response> {
	const model = requiredString(form, 'model');
	if (!model.ok) return model.response;
	const file = requiredFile(form);
	if (!file.ok) return file.response;
	const format = responseFormat(form);
	if (!format.ok) return format.response;
	const temperature = numberField(form, 'temperature', 0);
	if (!temperature.ok) return temperature.response;

	const executor = await findExecutorForModel(model.value, executors);
	if (executor === undefined || executor.translate === undefined) {
		return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
	}
	const decoded = await decode(file.value, signal, audioDecoder);
	if (!decoded.ok) return decoded.response;
	const speechSegments = await detectSpeechSegments(decoded.value, signal, vadExecutor);
	const request: TranslationRequest = {
		audio: decoded.value,
		model: model.value,
		prompt: optionalString(form, 'prompt'),
		responseFormat: format.value,
		temperature: temperature.value,
		speechSegments,
		vadOptions: DEFAULT_VAD_OPTIONS
	};

	try {
		return inferenceResponse(await executor.translate(request, signal), format.value);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (workerErrorCode(error) === 'model_not_available') {
			return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
		}
		throw new APIProxyError('Translation inference failed', { debug: error });
	}
}

export function invalidMultipartResponse(): Response {
	return validationError('file', 'Expected multipart form data', null);
}
