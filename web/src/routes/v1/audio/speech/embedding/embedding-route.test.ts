import { describe, expect, it, vi } from 'vitest';
import { APIProxyError } from '$lib/server/errors';
import { AudioDecodeError } from '$lib/server/audio-decode';
import type { SpeakerEmbeddingExecutor } from '$lib/server/executors/types';
import { _speakerEmbeddingResponse } from './+server.ts';

function executor(overrides: Partial<SpeakerEmbeddingExecutor> = {}): SpeakerEmbeddingExecutor {
	return {
		name: 'fixture-embedding',
		task: 'speaker-embedding',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => true,
		embed: async () => new Float32Array([-0.5, 0.25, 1]),
		...overrides
	};
}

function embeddingForm(): FormData {
	const form = new FormData();
	form.set('model', 'org/wespeaker');
	form.set('file', new Blob([new Uint8Array([1, 2])], { type: 'audio/pcm' }), 'clip.pcm');
	return form;
}

describe('POST /v1/audio/speech/embedding', () => {
	it('returns the OpenAI-compatible embedding envelope and sample usage', async () => {
		const embed = vi.fn(async () => new Float32Array([-0.5, 0.25, 1]));
		const signal = new AbortController().signal;
		const response = await _speakerEmbeddingResponse(
			embeddingForm(),
			signal,
			[executor({ embed })],
			async () => ({ data: new Float32Array(32_000), sampleRate: 16_000, name: 'clip' })
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			object: 'list',
			data: [{ object: 'embedding', embedding: [-0.5, 0.25, 1], index: 0 }],
			model: 'org/wespeaker',
			usage: { prompt_tokens: 32_000, total_tokens: 32_000 }
		});
		expect(embed).toHaveBeenCalledWith(
			{
				modelId: 'org/wespeaker',
				audio: expect.objectContaining({ sampleRate: 16_000, name: 'clip' })
			},
			signal
		);
	});

	it('returns structured validation errors for missing multipart fields', async () => {
		const signal = new AbortController().signal;
		const missingModel = await _speakerEmbeddingResponse(new FormData(), signal, []);
		expect(missingModel.status).toBe(422);
		expect(await missingModel.json()).toMatchObject({
			detail: [{ loc: ['body', 'model'] }]
		});

		const missingFileForm = new FormData();
		missingFileForm.set('model', 'org/wespeaker');
		const missingFile = await _speakerEmbeddingResponse(missingFileForm, signal, []);
		expect(missingFile.status).toBe(422);
		expect(await missingFile.json()).toMatchObject({
			detail: [{ loc: ['body', 'file'] }]
		});
	});

	it('returns 404 without decoding when no installed executor handles the model', async () => {
		const decode = vi.fn();
		const response = await _speakerEmbeddingResponse(
			embeddingForm(),
			new AbortController().signal,
			[executor({ canHandle: async () => false })],
			decode
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ detail: "Model 'org/wespeaker' not found" });
		expect(decode).not.toHaveBeenCalled();
	});

	it('preserves public decode errors and hides unexpected inference failures', async () => {
		const decodeFailure = await _speakerEmbeddingResponse(
			embeddingForm(),
			new AbortController().signal,
			[executor()],
			async () => {
				throw new AudioDecodeError('unsupported fixture', 415);
			}
		);
		expect(decodeFailure.status).toBe(415);
		expect(await decodeFailure.json()).toEqual({ detail: 'unsupported fixture' });

		await expect(
			_speakerEmbeddingResponse(
				embeddingForm(),
				new AbortController().signal,
				[
					executor({
						embed: async () => {
							throw new Error('native crash');
						}
					})
				],
				async () => ({ data: new Float32Array([0]), sampleRate: 16_000 })
			)
		).rejects.toBeInstanceOf(APIProxyError);
	});
});
