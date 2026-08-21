import { describe, expect, it, vi } from 'vitest';
import {
	encodeRpcAudio,
	encodeTranscriptionRequest,
	encodeTranslationRequest,
	PythonTranscriptionExecutor
} from './python-transcription.ts';
import type { TranscriptionRequest, TranslationRequest } from './types.ts';

function request(): TranscriptionRequest {
	return {
		audio: { data: new Float32Array([-1, -0.25, 0.25, 1]), sampleRate: 16_000, name: 'clip' },
		model: 'org/whisper-tiny',
		language: 'en',
		prompt: 'Names: Speachy',
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment', 'word'],
		speechSegments: [{ start: 0, end: 4 }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: Number.POSITIVE_INFINITY,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		hotwords: 'speachy',
		withoutTimestamps: false
	};
}

function translationRequest(): TranslationRequest {
	const transcription = request();
	return {
		audio: transcription.audio,
		model: transcription.model,
		prompt: transcription.prompt,
		responseFormat: transcription.responseFormat,
		temperature: transcription.temperature,
		speechSegments: transcription.speechSegments,
		vadOptions: transcription.vadOptions
	};
}

describe('Python transcription RPC codec', () => {
	it('encodes Float32 audio as canonical little-endian base64', () => {
		const encoded = encodeRpcAudio(request().audio);
		const bytes = Buffer.from(encoded.data as string, 'base64');
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(Array.from({ length: 4 }, (_, index) => view.getFloat32(index * 4, true))).toEqual([
			-1, -0.25, 0.25, 1
		]);
		expect(encoded).toMatchObject({
			encoding: 'f32le-base64',
			sample_rate: 16_000,
			name: 'clip'
		});
	});

	it('maps the executor request to snake-case protocol fields', () => {
		expect(encodeTranscriptionRequest(request())).toMatchObject({
			model: 'org/whisper-tiny',
			response_format: 'verbose_json',
			timestamp_granularities: ['segment', 'word'],
			speech_segments: [{ start: 0, end: 4 }],
			vad_options: {
				max_speech_duration_s: null,
				min_silence_duration_ms: 160,
				speech_pad_ms: 400
			},
			without_timestamps: false
		});
	});

	it('maps translation without transcription-only fields', () => {
		expect(encodeTranslationRequest(translationRequest())).toEqual({
			audio: encodeRpcAudio(translationRequest().audio),
			model: 'org/whisper-tiny',
			prompt: 'Names: Speachy',
			response_format: 'verbose_json',
			temperature: 0,
			speech_segments: [{ start: 0, end: 4 }],
			vad_options: {
				threshold: 0.5,
				neg_threshold: null,
				min_speech_duration_ms: 0,
				max_speech_duration_s: null,
				min_silence_duration_ms: 160,
				speech_pad_ms: 400
			}
		});
	});
});

describe('PythonTranscriptionExecutor', () => {
	it('returns a validated semantic transcription and forwards cancellation', async () => {
		const rpcRequest = vi.fn(async () => ({
			text: 'hello',
			language: 'en',
			duration: 1.25,
			segments: [{ id: 0, start: 0, end: 1.25, text: 'hello' }],
			words: null
		}));
		const executor = new PythonTranscriptionExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;

		await expect(executor.transcribe(request(), signal)).resolves.toEqual({
			text: 'hello',
			language: 'en',
			duration: 1.25,
			segments: [{ id: 0, start: 0, end: 1.25, text: 'hello' }]
		});
		expect(rpcRequest).toHaveBeenCalledWith('transcribe', expect.any(Object), { signal });
	});

	it('exposes only locally installed models as handleable', async () => {
		const model = {
			id: 'org/whisper-tiny',
			created: 1,
			object: 'model' as const,
			owned_by: 'org',
			language: ['en'],
			task: 'automatic-speech-recognition' as const
		};
		const executor = new PythonTranscriptionExecutor(
			{ request: vi.fn() },
			{ listLocal: async () => [model], listRemote: async () => [] }
		);
		await expect(executor.canHandle(model.id)).resolves.toBe(true);
		await expect(executor.canHandle('org/missing')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			{
				id: model.id,
				created: 1,
				ownedBy: 'org',
				task: 'automatic-speech-recognition',
				language: ['en']
			}
		]);
	});

	it('translates through the dedicated worker method and validates the result', async () => {
		const rpcRequest = vi.fn(async () => ({ text: 'translated' }));
		const executor = new PythonTranscriptionExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;

		await expect(executor.translate(translationRequest(), signal)).resolves.toEqual({
			text: 'translated'
		});
		expect(rpcRequest).toHaveBeenCalledWith(
			'translate',
			encodeTranslationRequest(translationRequest()),
			{
				signal
			}
		);
	});

	it('streams validated events in order and reconstructs terminal text from deltas', async () => {
		const rpcRequest = vi.fn(async (_method, _params, options) => {
			options?.onEvent?.({ type: 'transcript.text.delta', delta: 'hello' });
			options?.onEvent?.({ type: 'transcript.text.delta', delta: ' world' });
			options?.onEvent?.({ type: 'transcript.text.done', text: '' });
			return { event_count: 3 };
		});
		const executor = new PythonTranscriptionExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;
		const events = [];

		for await (const event of executor.transcribeStream(request(), signal)) events.push(event);

		expect(events).toEqual([
			{ type: 'delta', delta: 'hello' },
			{ type: 'delta', delta: ' world' },
			{ type: 'done', text: 'hello world' }
		]);
		expect(rpcRequest).toHaveBeenCalledWith(
			'transcribe_stream',
			encodeTranscriptionRequest(request()),
			expect.objectContaining({ signal: expect.any(AbortSignal), onEvent: expect.any(Function) })
		);
	});

	it('rejects a stream whose terminal event count does not match delivery', async () => {
		const executor = new PythonTranscriptionExecutor({
			request: async (_method, _params, options) => {
				options?.onEvent?.({ type: 'transcript.text.done', text: '' });
				return { event_count: 2 };
			}
		});

		const consume = async (): Promise<void> => {
			for await (const _event of executor.transcribeStream(
				request(),
				new AbortController().signal
			)) {
				// Drain the iterator so its terminal result is validated.
			}
		};
		await expect(consume()).rejects.toThrow('invalid event count');
	});

	it('cancels the worker request when the stream consumer stops early', async () => {
		let abortReason: unknown;
		const executor = new PythonTranscriptionExecutor({
			request: (_method, _params, options) => {
				options?.onEvent?.({ type: 'transcript.text.delta', delta: 'partial' });
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener(
						'abort',
						() => {
							abortReason = options.signal?.reason;
							reject(abortReason);
						},
						{ once: true }
					);
				});
			}
		});
		const iterator = executor
			.transcribeStream(request(), new AbortController().signal)
			[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toEqual({
			done: false,
			value: { type: 'delta', delta: 'partial' }
		});
		await iterator.return?.();

		expect(abortReason).toBeInstanceOf(Error);
		expect((abortReason as Error).message).toBe('Transcription stream consumer closed');
	});
});
