import { describe, expect, it, vi } from 'vitest';
import { PythonSpeechExecutor } from './python-speech.ts';

function audioEvent(samples: number[], sampleRate = 24_000): Record<string, unknown> {
	const bytes = Buffer.alloc(samples.length * 4);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let index = 0; index < samples.length; index += 1) {
		view.setFloat32(index * 4, samples[index]!, true);
	}
	return {
		type: 'speech.audio.delta',
		audio: {
			encoding: 'f32le-base64',
			data: bytes.toString('base64'),
			sample_rate: sampleRate
		}
	};
}

describe('PythonSpeechExecutor', () => {
	it('streams validated Float32 audio chunks in order', async () => {
		const rpcRequest = vi.fn(async (_method, _params, options) => {
			options?.onEvent?.(audioEvent([-0.5, 0.5]));
			options?.onEvent?.(audioEvent([0.25]));
			return { event_count: 2 };
		});
		const executor = new PythonSpeechExecutor({ request: rpcRequest });
		const chunks = [];

		for await (const chunk of executor.synthesize(
			{ model: 'org/kokoro', voice: 'af_heart', text: 'Hello', speed: 1 },
			new AbortController().signal
		)) {
			chunks.push(chunk);
		}

		expect(
			chunks.map((chunk) => ({ data: [...chunk.data], sampleRate: chunk.sampleRate }))
		).toEqual([
			{ data: [-0.5, 0.5], sampleRate: 24_000 },
			{ data: [0.25], sampleRate: 24_000 }
		]);
		expect(rpcRequest).toHaveBeenCalledWith(
			'synthesize',
			{ model: 'org/kokoro', voice: 'af_heart', text: 'Hello', speed: 1 },
			expect.objectContaining({ signal: expect.any(AbortSignal), onEvent: expect.any(Function) })
		);
	});

	it('lists voices for the requested local model only', async () => {
		const localModels = [
			{
				id: 'org/kokoro',
				created: 1,
				object: 'model' as const,
				owned_by: 'org',
				language: ['en'],
				task: 'text-to-speech' as const,
				voices: [
					{ id: 'af_heart', name: 'af_heart', language: 'en-us' },
					{ id: 'am_adam', name: 'am_adam', language: 'en-us' }
				]
			},
			{
				id: 'org/piper',
				created: 2,
				object: 'model' as const,
				owned_by: 'org',
				language: ['en'],
				task: 'text-to-speech' as const,
				voices: [{ id: 'lessac', name: 'lessac', language: 'en-us' }]
			}
		];
		const executor = new PythonSpeechExecutor(
			{ request: vi.fn() },
			{ listLocal: async () => localModels, listRemote: async () => [] }
		);

		await expect(executor.canHandle('org/kokoro')).resolves.toBe(true);
		await expect(executor.listVoices('org/kokoro')).resolves.toEqual(['af_heart', 'am_adam']);
		await expect(executor.listVoices('org/missing')).resolves.toEqual([]);
	});

	it('rejects malformed audio and mismatched terminal counts', async () => {
		const executor = new PythonSpeechExecutor({
			request: async (_method, _params, options) => {
				options?.onEvent?.({
					type: 'speech.audio.delta',
					audio: { encoding: 'f32le-base64', data: 'not base64', sample_rate: 24_000 }
				});
				return { event_count: 2 };
			}
		});
		const consume = async (): Promise<void> => {
			for await (const _chunk of executor.synthesize(
				{ model: 'org/kokoro', voice: 'af_heart', text: 'Hello', speed: 1 },
				new AbortController().signal
			)) {
				// Drain to validation.
			}
		};

		await expect(consume()).rejects.toThrow('Invalid speech audio payload');
	});

	it('rejects a valid stream whose terminal event count does not match delivery', async () => {
		const executor = new PythonSpeechExecutor({
			request: async (_method, _params, options) => {
				options?.onEvent?.(audioEvent([0.25]));
				return { event_count: 2 };
			}
		});
		const consume = async (): Promise<void> => {
			for await (const _chunk of executor.synthesize(
				{ model: 'org/kokoro', voice: 'af_heart', text: 'Hello', speed: 1 },
				new AbortController().signal
			)) {
				// Drain to terminal validation.
			}
		};

		await expect(consume()).rejects.toThrow('invalid event count');
	});

	it('cancels the worker request when the speech consumer stops early', async () => {
		let abortReason: unknown;
		const executor = new PythonSpeechExecutor({
			request: (_method, _params, options) => {
				options?.onEvent?.(audioEvent([0.25]));
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
			.synthesize(
				{ model: 'org/kokoro', voice: 'af_heart', text: 'Hello', speed: 1 },
				new AbortController().signal
			)
			[Symbol.asyncIterator]();

		await expect(iterator.next()).resolves.toMatchObject({ done: false });
		await iterator.return?.();
		expect((abortReason as Error).message).toBe('Speech stream consumer closed');
	});
});
