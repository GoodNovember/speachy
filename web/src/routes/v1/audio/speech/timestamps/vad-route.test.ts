import { describe, expect, it, vi } from 'vitest';
import type { VadExecutor } from '$lib/server/executors/types';
import { _vadResponse } from './+server.ts';

function executor(overrides: Partial<VadExecutor> = {}): VadExecutor {
	return {
		name: 'fixture-vad',
		task: 'voice-activity-detection',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async (model) => model === 'silero_vad_v5',
		detectSpeech: async () => [{ start: 1024, end: 21_168 }],
		...overrides
	};
}

function form(): FormData {
	const value = new FormData();
	value.set('file', new Blob([new Uint8Array([1, 2])], { type: 'audio/pcm' }), 'clip.pcm');
	return value;
}

describe('POST /v1/audio/speech/timestamps', () => {
	it('uses the reference defaults and returns integer milliseconds', async () => {
		const detectSpeech = vi.fn(async () => [{ start: 1024, end: 21_168 }]);
		const signal = new AbortController().signal;
		const response = await _vadResponse(form(), signal, executor({ detectSpeech }), async () => ({
			data: new Float32Array(32_000),
			sampleRate: 16_000,
			name: 'clip'
		}));

		expect(await response.json()).toEqual([{ start: 64, end: 1323 }]);
		expect(detectSpeech).toHaveBeenCalledWith(
			{
				audio: expect.objectContaining({ sampleRate: 16_000 }),
				modelId: 'silero_vad_v5',
				vadOptions: {
					threshold: 0.75,
					negThreshold: undefined,
					minSpeechDurationMs: 0,
					maxSpeechDurationS: Number.POSITIVE_INFINITY,
					minSilenceDurationMs: 1000,
					speechPadMs: 0
				}
			},
			signal
		);
	});

	it('rejects invalid options and unknown models before decoding', async () => {
		const invalid = form();
		invalid.set('threshold', '1.1');
		expect((await _vadResponse(invalid, new AbortController().signal, executor())).status).toBe(
			422
		);

		const unknown = form();
		unknown.set('model', 'other');
		const decode = vi.fn();
		expect(
			(await _vadResponse(unknown, new AbortController().signal, executor(), decode)).status
		).toBe(404);
		expect(decode).not.toHaveBeenCalled();
	});
});
