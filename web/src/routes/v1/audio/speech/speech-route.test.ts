import { describe, expect, it, vi } from 'vitest';
import { APIProxyError } from '$lib/server/errors';
import type { Audio, SpeechExecutor } from '$lib/server/executors/types';
import { _speechResponse } from './+server.ts';

function executor(overrides: Partial<SpeechExecutor> = {}): SpeechExecutor {
	return {
		name: 'fixture-speech',
		task: 'text-to-speech',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => true,
		listVoices: async () => ['af_heart'],
		async *synthesize(): AsyncIterable<Audio> {
			yield { data: new Float32Array([0.5, -0.5]), sampleRate: 24_000 };
			yield { data: new Float32Array([0.25]), sampleRate: 24_000 };
		},
		...overrides
	};
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: 'org/kokoro',
		voice: 'af_heart',
		input: 'Hello, **world**! 😀',
		response_format: 'pcm',
		...overrides
	};
}

async function sseEvents(response: Response): Promise<unknown[]> {
	return (await response.text())
		.split('\n\n')
		.filter(Boolean)
		.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
}

function failingAudio(error: Error): AsyncIterable<Audio> {
	return {
		[Symbol.asyncIterator]() {
			return { next: async () => Promise.reject(error) };
		}
	};
}

describe('POST /v1/audio/speech', () => {
	it('streams PCM and passes sanitized text through the speech executor', async () => {
		const synthesize = vi.fn(async function* (): AsyncIterable<Audio> {
			yield { data: new Float32Array([0.5, -0.5]), sampleRate: 24_000 };
			yield { data: new Float32Array([0.25]), sampleRate: 24_000 };
		});
		const signal = new AbortController().signal;
		const response = await _speechResponse(body({ speed: 1.25 }), signal, [
			executor({ synthesize })
		]);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('audio/pcm');
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes.byteLength).toBe(6);
		const view = new DataView(bytes.buffer);
		expect([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)]).toEqual([
			16_383, -16_383, 8_191
		]);
		expect(synthesize).toHaveBeenCalledWith(
			{
				model: 'org/kokoro',
				voice: 'af_heart',
				text: 'Hello, world! ',
				speed: 1.25
			},
			expect.any(AbortSignal)
		);
	});

	it('streams an unknown-length WAV header followed by audio', async () => {
		const response = await _speechResponse(
			body({ response_format: 'wav' }),
			new AbortController().signal,
			[executor()]
		);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(response.headers.get('content-type')).toContain('audio/wav');
		expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
		expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(0xffffffff);
		expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
	});

	it('emits PCM16 audio deltas and a terminal usage event over SSE', async () => {
		const response = await _speechResponse(
			body({ stream_format: 'sse' }),
			new AbortController().signal,
			[executor()]
		);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const events = (await sseEvents(response)) as Array<{
			type: string;
			audio?: string;
			token_usage?: unknown;
		}>;
		expect(events.map((event) => event.type)).toEqual([
			'speech.audio.delta',
			'speech.audio.delta',
			'speech.audio.done'
		]);
		expect(Buffer.from(events[0]!.audio!, 'base64').byteLength).toBe(4);
		expect(events[2]!.token_usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0
		});
	});

	it.each([
		['mp3', 'audio/mpeg'],
		['flac', 'audio/flac'],
		['opus', 'audio/opus'],
		['aac', 'audio/aac']
	])('uses the %s formatter and media type', async (format, contentType) => {
		const formatter = vi.fn(async function* (
			audios: AsyncIterable<Audio>,
			requestedFormat: string,
			options: { sampleRate?: number }
		): AsyncIterable<Uint8Array> {
			for await (const _audio of audios) {
				// Drain the inference stream like the real encoder.
			}
			expect(requestedFormat).toBe(format);
			expect(options.sampleRate).toBe(16_000);
			yield new Uint8Array([1, 2, 3]);
		});
		const response = await _speechResponse(
			body({ response_format: format, sample_rate: 16_000 }),
			new AbortController().signal,
			[executor()],
			formatter
		);
		expect(response.headers.get('content-type')).toContain(contentType);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
		expect(formatter).toHaveBeenCalledOnce();
	});

	it('returns structured validation errors before executor selection', async () => {
		const signal = new AbortController().signal;
		const missing = await _speechResponse({}, signal, []);
		expect(missing.status).toBe(422);
		expect(await missing.json()).toMatchObject({ detail: [{ loc: ['body', 'model'] }] });

		for (const [field, value] of [
			['response_format', 'ogg'],
			['stream_format', 'websocket'],
			['speed', 9],
			['sample_rate', 7_999]
		] as const) {
			const response = await _speechResponse(body({ [field]: value }), signal, []);
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ detail: [{ loc: ['body', field] }] });
		}

		const explicitNull = await _speechResponse(body({ speed: null }), signal, []);
		expect(explicitNull.status).toBe(422);
		expect(await explicitNull.json()).toMatchObject({ detail: [{ loc: ['body', 'speed'] }] });
	});

	it('rejects missing models and voices before inference starts', async () => {
		const synthesize = vi.fn();
		const missingModel = await _speechResponse(body(), new AbortController().signal, [
			executor({ canHandle: async () => false, synthesize })
		]);
		expect(missingModel.status).toBe(404);
		expect(synthesize).not.toHaveBeenCalled();

		const missingVoice = await _speechResponse(
			body({ voice: 'not-a-voice' }),
			new AbortController().signal,
			[executor({ synthesize })]
		);
		expect(missingVoice.status).toBe(422);
		expect(await missingVoice.json()).toEqual({
			detail: "Voice 'not-a-voice' is not available for model 'org/kokoro'"
		});
		expect(synthesize).not.toHaveBeenCalled();
	});

	it('maps eager model validation to 422 and hides unexpected failures', async () => {
		const invalidParams = Object.assign(new Error('Speed must be between 0.5 and 2.0'), {
			code: 'invalid_params'
		});
		const rejected = await _speechResponse(body(), new AbortController().signal, [
			executor({
				synthesize: () => failingAudio(invalidParams)
			})
		]);
		expect(rejected.status).toBe(422);
		expect(await rejected.json()).toEqual({ detail: 'Speed must be between 0.5 and 2.0' });

		await expect(
			_speechResponse(body(), new AbortController().signal, [
				executor({
					synthesize: () => failingAudio(new Error('native crash'))
				})
			])
		).rejects.toBeInstanceOf(APIProxyError);
	});

	it('aborts inference when the response consumer cancels', async () => {
		let inferenceSignal: AbortSignal | undefined;
		const response = await _speechResponse(body(), new AbortController().signal, [
			executor({
				async *synthesize(_request, signal) {
					inferenceSignal = signal;
					yield { data: new Float32Array([0.25]), sampleRate: 24_000 };
					await new Promise<void>((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(signal.reason), { once: true });
					});
				}
			})
		]);
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel(new Error('client left'));
		expect(inferenceSignal?.aborted).toBe(true);
	});
});
