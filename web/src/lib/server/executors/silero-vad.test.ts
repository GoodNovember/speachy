import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../audio-decode.ts';
import {
	SILERO_VAD_MODEL_ID,
	SileroVadExecutor,
	speechTimestampsFromProbabilities
} from './silero-vad.ts';

describe('Silero VAD executor', () => {
	it('ports the hysteresis and sample-index timestamp contract', () => {
		expect(
			speechTimestampsFromProbabilities(new Float32Array([0.1, 0.8, 0.7, 0.6, 0.1]), 2560, {
				threshold: 0.5,
				minSpeechDurationMs: 0,
				maxSpeechDurationS: Number.POSITIVE_INFINITY,
				minSilenceDurationMs: 0,
				speechPadMs: 0
			})
		).toEqual([{ start: 512, end: 2048 }]);
	});

	it('matches the checked-in Python reference timestamps', async () => {
		const bytes = await readFile(resolve('..', 'audio.wav'));
		const audio = await decodeAudioUpload(new Blob([bytes], { type: 'audio/wav' }));
		const timestamps = await new SileroVadExecutor().detectSpeech(
			{
				audio,
				modelId: SILERO_VAD_MODEL_ID,
				vadOptions: {
					threshold: 0.75,
					minSpeechDurationMs: 0,
					maxSpeechDurationS: Number.POSITIVE_INFINITY,
					minSilenceDurationMs: 1000,
					speechPadMs: 0
				}
			},
			new AbortController().signal
		);
		expect(
			timestamps.map(({ start, end }) => ({
				start: Math.floor(start / 16),
				end: Math.floor(end / 16)
			}))
		).toEqual([{ start: 64, end: 1323 }]);
	});
});
