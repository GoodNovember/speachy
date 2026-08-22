import { describe, expect, it, vi } from 'vitest';
import { PythonDiarizationExecutor } from './python-diarization.ts';

describe('PythonDiarizationExecutor', () => {
	it('encodes audio, forwards the speaker count and cancellation, and validates segments', async () => {
		const rpcRequest = vi.fn(async () => [
			{ start: 0.25, end: 1.5, speaker: 'SPEAKER_00' },
			{ start: 1.75, end: 2, speaker: 'SPEAKER_01' }
		]);
		const executor = new PythonDiarizationExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;

		await expect(
			executor.diarize(
				{
					modelId: 'org/pyannote',
					numSpeakers: 2,
					audio: { data: new Float32Array([-1, 0, 1]), sampleRate: 16_000, name: 'clip' }
				},
				signal
			)
		).resolves.toEqual([
			{ start: 0.25, end: 1.5, speaker: 'SPEAKER_00' },
			{ start: 1.75, end: 2, speaker: 'SPEAKER_01' }
		]);
		expect(rpcRequest).toHaveBeenCalledWith(
			'diarize',
			expect.objectContaining({
				model_id: 'org/pyannote',
				num_speakers: 2,
				audio: expect.objectContaining({
					encoding: 'f32le-base64',
					sample_rate: 16_000,
					name: 'clip'
				})
			}),
			{ signal }
		);
	});

	it('uses null for automatic speaker counting', async () => {
		const rpcRequest = vi.fn(async () => []);
		const executor = new PythonDiarizationExecutor({ request: rpcRequest });
		await executor.diarize(
			{
				modelId: 'org/pyannote',
				audio: { data: new Float32Array(), sampleRate: 16_000 }
			},
			new AbortController().signal
		);
		expect(rpcRequest).toHaveBeenCalledWith(
			'diarize',
			expect.objectContaining({ num_speakers: null }),
			expect.any(Object)
		);
	});

	it('rejects malformed segment shapes and ranges', async () => {
		const request = {
			modelId: 'org/pyannote',
			audio: { data: new Float32Array([0]), sampleRate: 16_000 }
		};
		const signal = new AbortController().signal;
		for (const result of [
			{},
			[{ start: -1, end: 1, speaker: 'SPEAKER_00' }],
			[{ start: 1, end: 1, speaker: 'SPEAKER_00' }],
			[{ start: 2, end: 1, speaker: 'SPEAKER_00' }],
			[{ start: 0, end: Number.NaN, speaker: 'SPEAKER_00' }],
			[{ start: 0, end: 1, speaker: '' }]
		]) {
			const executor = new PythonDiarizationExecutor({ request: async () => result });
			await expect(executor.diarize(request, signal)).rejects.toThrow('Invalid diarization');
		}
	});

	it('exposes only locally installed diarization models as handleable', async () => {
		const model = {
			id: 'org/pyannote',
			created: 1,
			object: 'model' as const,
			owned_by: 'org',
			language: null,
			task: 'speaker-diarization' as const
		};
		const executor = new PythonDiarizationExecutor(
			{ request: vi.fn() },
			{ listLocal: async () => [model], listRemote: async () => [] }
		);

		await expect(executor.canHandle(model.id)).resolves.toBe(true);
		await expect(executor.canHandle('org/missing')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			{ id: model.id, created: 1, ownedBy: 'org', task: 'speaker-diarization' }
		]);
	});
});
