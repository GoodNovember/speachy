import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_MODEL_ID
} from '../../src/lib/server/native-diarization.ts';
import { SherpaDiarizationExecutor } from '../../src/lib/server/executors/sherpa-diarization.ts';
import { _diarizationResponse } from '../../src/routes/v1/audio/diarization/+server.ts';

const modelPaths = resolveSherpaDiarizationModelPaths();
const audioPath =
	process.env.SPEACHY_SHERPA_DIARIZATION_AUDIO ??
	resolve(modelPaths.directory, '1-two-speakers-en.wav');
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_NATIVE_DIARIZATION_INTEGRATION === '1' &&
	existsSync(modelPaths.segmentation) &&
	existsSync(modelPaths.embedding) &&
	existsSync(audioPath);

describe.runIf(RUN_INTEGRATION)('native diarization integration', () => {
	it('serves two-speaker sherpa segments through the HTTP boundary without Python', async () => {
		const bytes = await readFile(audioPath);
		const body = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(body).set(bytes);
		const form = new FormData();
		form.set('file', new Blob([body], { type: 'audio/wav' }), 'two-speakers.wav');
		form.set('model', SHERPA_DIARIZATION_MODEL_ID);
		form.set('num_speakers', '2');
		const executor = new SherpaDiarizationExecutor();
		try {
			const response = await _diarizationResponse(form, AbortSignal.timeout(120_000), [executor]);
			expect(response.status).toBe(200);
			const result = (await response.json()) as {
				duration: number;
				segments: { start: number; end: number; speaker: string }[];
			};
			expect(result.duration).toBeGreaterThan(1);
			expect(result.segments.length).toBeGreaterThan(1);
			expect(new Set(result.segments.map((segment) => segment.speaker))).toEqual(
				new Set(['SPEAKER_00', 'SPEAKER_01'])
			);
			expect(
				result.segments.every(
					(segment) =>
						Number.isFinite(segment.start) &&
						Number.isFinite(segment.end) &&
						segment.start >= 0 &&
						segment.end > segment.start
				)
			).toBe(true);
		} finally {
			await executor.close();
		}
	}, 125_000);
});
