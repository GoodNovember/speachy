import { APIProxyError } from './errors.ts';
import { findExecutorForModel } from './executors/executor-registry.ts';
import type { Audio, SpeechExecutor, SpeechRequest } from './executors/types.ts';
import {
	float32ToPcm16Bytes,
	streamAudioAsFormattedBytes,
	type AudioFormat,
	type AudioStreamOptions
} from './audio.ts';
import { formatAsSse, stripEmojis, stripMarkdownEmphasis } from './text-utils.ts';

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };
type SpeechStreamFormat = 'audio' | 'sse';
type AudioFormatter = (
	audios: AsyncIterable<Audio>,
	format: AudioFormat,
	options: AudioStreamOptions
) => AsyncIterable<Uint8Array>;

const AUDIO_FORMATS: readonly AudioFormat[] = ['mp3', 'wav', 'pcm', 'flac', 'opus', 'aac'];
const CONTENT_TYPES: Record<AudioFormat, string> = {
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	pcm: 'audio/pcm',
	flac: 'audio/flac',
	opus: 'audio/opus',
	aac: 'audio/aac'
};

function validationError(field: string, message: string, input: unknown): Response {
	return Response.json(
		{
			detail: [
				{
					type: 'value_error',
					loc: ['body', field],
					msg: message,
					input
				}
			]
		},
		{ status: 422 }
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string): Parsed<string> {
	const value = body[field];
	if (typeof value !== 'string' || value.length === 0) {
		return { ok: false, response: validationError(field, 'Field required', value ?? null) };
	}
	return { ok: true, value };
}

function audioFormat(body: Record<string, unknown>): Parsed<AudioFormat> {
	const value = body.response_format === undefined ? 'mp3' : body.response_format;
	if (typeof value !== 'string' || !AUDIO_FORMATS.includes(value as AudioFormat)) {
		return {
			ok: false,
			response: validationError(
				'response_format',
				"Input should be 'mp3', 'wav', 'pcm', 'flac', 'opus' or 'aac'",
				value
			)
		};
	}
	return { ok: true, value: value as AudioFormat };
}

function streamFormat(body: Record<string, unknown>): Parsed<SpeechStreamFormat> {
	const value = body.stream_format === undefined ? 'audio' : body.stream_format;
	if (value !== 'audio' && value !== 'sse') {
		return {
			ok: false,
			response: validationError('stream_format', "Input should be 'audio' or 'sse'", value)
		};
	}
	return { ok: true, value };
}

function speed(body: Record<string, unknown>): Parsed<number> {
	const value = body.speed === undefined ? 1 : body.speed;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 4) {
		return {
			ok: false,
			response: validationError('speed', 'Input should be between 0.25 and 4.0', value)
		};
	}
	return { ok: true, value };
}

function sampleRate(body: Record<string, unknown>): Parsed<number | undefined> {
	const value = body.sample_rate;
	if (value === undefined || value === null) return { ok: true, value: undefined };
	if (!Number.isInteger(value) || (value as number) < 8_000 || (value as number) > 48_000) {
		return {
			ok: false,
			response: validationError(
				'sample_rate',
				'Input should be an integer between 8000 and 48000',
				value
			)
		};
	}
	return { ok: true, value: value as number };
}

function workerErrorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function workerErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Invalid speech request';
}

type ActiveSpeech = {
	controller: AbortController;
	dispose(): void;
	iterator: AsyncIterator<Audio>;
	first: IteratorResult<Audio>;
};

async function startSpeech(
	executor: SpeechExecutor,
	request: SpeechRequest,
	signal: AbortSignal
): Promise<ActiveSpeech> {
	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort(signal.reason);
	if (signal.aborted) forwardAbort();
	else signal.addEventListener('abort', forwardAbort, { once: true });
	const iterator = executor.synthesize(request, controller.signal)[Symbol.asyncIterator]();
	try {
		return {
			controller,
			dispose: () => signal.removeEventListener('abort', forwardAbort),
			iterator,
			first: await iterator.next()
		};
	} catch (error) {
		signal.removeEventListener('abort', forwardAbort);
		await iterator.return?.();
		throw error;
	}
}

async function* audioWithFirst(active: ActiveSpeech): AsyncGenerator<Audio> {
	let next = active.first;
	try {
		while (!next.done) {
			yield next.value;
			next = await active.iterator.next();
		}
	} finally {
		await active.iterator.return?.();
	}
}

async function* speechSse(active: ActiveSpeech): AsyncGenerator<Uint8Array> {
	const encoder = new TextEncoder();
	for await (const audio of audioWithFirst(active)) {
		const event = {
			type: 'speech.audio.delta',
			audio: Buffer.from(float32ToPcm16Bytes(audio.data)).toString('base64')
		};
		yield encoder.encode(formatAsSse(JSON.stringify(event)));
	}
	yield encoder.encode(
		formatAsSse(
			JSON.stringify({
				type: 'speech.audio.done',
				token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
			})
		)
	);
}

function streamingResponse(
	bytes: AsyncIterable<Uint8Array>,
	active: ActiveSpeech,
	contentType: string
): Response {
	const iterator = bytes[Symbol.asyncIterator]();
	let finished = false;
	const finish = (): void => {
		if (finished) return;
		finished = true;
		active.dispose();
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
				streamController.enqueue(next.value);
			} catch (error) {
				finish();
				active.controller.abort(error);
				streamController.error(error);
			}
		},
		async cancel(reason) {
			finish();
			active.controller.abort(reason ?? new Error('Speech response stream cancelled'));
			await Promise.allSettled([iterator.return?.(), active.iterator.return?.()]);
		}
	});
	return new Response(body, { headers: { 'content-type': contentType } });
}

export async function createSpeechResponse(
	body: unknown,
	signal: AbortSignal,
	executors: readonly SpeechExecutor[],
	formatAudio: AudioFormatter = streamAudioAsFormattedBytes
): Promise<Response> {
	if (!isRecord(body)) return validationError('body', 'Input should be a valid object', body);
	const model = requiredString(body, 'model');
	if (!model.ok) return model.response;
	const input = requiredString(body, 'input');
	if (!input.ok) return input.response;
	const voice = requiredString(body, 'voice');
	if (!voice.ok) return voice.response;
	const format = audioFormat(body);
	if (!format.ok) return format.response;
	const requestedStreamFormat = streamFormat(body);
	if (!requestedStreamFormat.ok) return requestedStreamFormat.response;
	const requestedSpeed = speed(body);
	if (!requestedSpeed.ok) return requestedSpeed.response;
	const requestedSampleRate = sampleRate(body);
	if (!requestedSampleRate.ok) return requestedSampleRate.response;
	const text = stripMarkdownEmphasis(stripEmojis(input.value));
	if (text.trim().length === 0) {
		return validationError('input', 'Input must contain speakable text', input.value);
	}

	const executor = await findExecutorForModel(model.value, executors);
	if (executor === undefined) {
		return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
	}
	const voices = await executor.listVoices(model.value);
	if (!voices.includes(voice.value)) {
		return Response.json(
			{ detail: `Voice '${voice.value}' is not available for model '${model.value}'` },
			{ status: 422 }
		);
	}

	let active: ActiveSpeech;
	try {
		active = await startSpeech(
			executor,
			{ model: model.value, voice: voice.value, text, speed: requestedSpeed.value },
			signal
		);
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (workerErrorCode(error) === 'model_not_available') {
			return Response.json({ detail: `Model '${model.value}' not found` }, { status: 404 });
		}
		if (workerErrorCode(error) === 'invalid_params') {
			return Response.json({ detail: workerErrorMessage(error) }, { status: 422 });
		}
		throw new APIProxyError('Speech inference failed', { debug: error });
	}

	if (requestedStreamFormat.value === 'sse') {
		return streamingResponse(speechSse(active), active, 'text/event-stream; charset=utf-8');
	}
	return streamingResponse(
		formatAudio(audioWithFirst(active), format.value, {
			...(requestedSampleRate.value === undefined ? {} : { sampleRate: requestedSampleRate.value }),
			signal: active.controller.signal
		}),
		active,
		CONTENT_TYPES[format.value]
	);
}

export function invalidJsonResponse(): Response {
	return validationError('body', 'Expected a JSON request body', null);
}
