import { describe, expect, it, vi } from 'vitest';
import { PythonSpeakerEmbeddingExecutor } from './python-speaker-embedding.ts';

function encodedEmbedding(values: number[]): Record<string, unknown> {
	const bytes = Buffer.alloc(values.length * 4);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let index = 0; index < values.length; index += 1) {
		view.setFloat32(index * 4, values[index]!, true);
	}
	return { encoding: 'f32le-base64', data: bytes.toString('base64'), length: values.length };
}

describe('PythonSpeakerEmbeddingExecutor', () => {
	it('encodes audio, forwards cancellation, and decodes a finite Float32 vector', async () => {
		const rpcRequest = vi.fn(async () => encodedEmbedding([-0.5, 0.25, 1]));
		const executor = new PythonSpeakerEmbeddingExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;

		await expect(
			executor.embed(
				{
					modelId: 'org/wespeaker',
					audio: { data: new Float32Array([-1, 0, 1]), sampleRate: 16_000, name: 'clip' }
				},
				signal
			)
		).resolves.toEqual(new Float32Array([-0.5, 0.25, 1]));
		expect(rpcRequest).toHaveBeenCalledWith(
			'embed',
			expect.objectContaining({
				model_id: 'org/wespeaker',
				audio: expect.objectContaining({
					encoding: 'f32le-base64',
					sample_rate: 16_000,
					name: 'clip'
				})
			}),
			{ signal }
		);
	});

	it('rejects malformed lengths and non-finite values', async () => {
		const request = {
			modelId: 'org/wespeaker',
			audio: { data: new Float32Array([0]), sampleRate: 16_000 }
		};
		const signal = new AbortController().signal;
		const badLength = new PythonSpeakerEmbeddingExecutor({
			request: async () => ({ ...encodedEmbedding([1]), length: 2 })
		});
		await expect(badLength.embed(request, signal)).rejects.toThrow('Invalid speaker embedding');

		const badValue = new PythonSpeakerEmbeddingExecutor({
			request: async () => encodedEmbedding([Number.NaN])
		});
		await expect(badValue.embed(request, signal)).rejects.toThrow('non-finite');
	});

	it('exposes only locally installed embedding models as handleable', async () => {
		const model = {
			id: 'org/wespeaker',
			created: 1,
			object: 'model' as const,
			owned_by: 'org',
			language: null,
			task: 'speaker-embedding' as const
		};
		const executor = new PythonSpeakerEmbeddingExecutor(
			{ request: vi.fn() },
			{ listLocal: async () => [model], listRemote: async () => [] }
		);

		await expect(executor.canHandle(model.id)).resolves.toBe(true);
		await expect(executor.canHandle('org/missing')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			{ id: model.id, created: 1, ownedBy: 'org', task: 'speaker-embedding' }
		]);
	});
});
