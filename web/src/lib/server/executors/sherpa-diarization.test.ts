import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_MODEL_ID,
	type SherpaDiarizationModelPaths
} from '../native-diarization.ts';
import { SherpaDiarizationExecutor } from './sherpa-diarization.ts';

let directory: string;
let paths: SherpaDiarizationModelPaths;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'speachy-sherpa-diarization-'));
	paths = resolveSherpaDiarizationModelPaths(
		{ SPEACHY_SHERPA_DIARIZATION_MODEL_DIR: directory },
		directory
	);
	await Promise.all([writeFile(paths.segmentation, ''), writeFile(paths.embedding, '')]);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('SherpaDiarizationExecutor', () => {
	it('lists only the complete local native bundle', async () => {
		const executor = new SherpaDiarizationExecutor({
			paths,
			client: { call: vi.fn() }
		});
		await expect(executor.listLocalModels()).resolves.toEqual([
			{
				id: SHERPA_DIARIZATION_MODEL_ID,
				created: expect.any(Number),
				ownedBy: 'sherpa-onnx',
				task: 'speaker-diarization',
				language: ['en']
			}
		]);
		await expect(executor.canHandle(SHERPA_DIARIZATION_MODEL_ID)).resolves.toBe(true);
	});

	it('resamples to 16 kHz, forwards a fixed count, and maps stable speaker labels', async () => {
		const call = vi.fn(async () => [
			{ start: 1.25, end: 2, speaker: 1 },
			{ start: 0.1, end: 1, speaker: 0 }
		]);
		const executor = new SherpaDiarizationExecutor({ paths, client: { call } });
		const signal = new AbortController().signal;
		await expect(
			executor.diarize(
				{
					modelId: SHERPA_DIARIZATION_MODEL_ID,
					numSpeakers: 2,
					audio: { data: new Float32Array(8_000), sampleRate: 8_000 }
				},
				signal
			)
		).resolves.toEqual([
			{ start: 0.1, end: 1, speaker: 'SPEAKER_00' },
			{ start: 1.25, end: 2, speaker: 'SPEAKER_01' }
		]);
		expect(call).toHaveBeenCalledWith(
			'diarize',
			{
				samples: expect.objectContaining({ length: 16_000 }),
				sampleRate: 16_000,
				numSpeakers: 2
			},
			signal
		);
	});

	it('uses zero for sherpa automatic clustering and forwards cancellation', async () => {
		const call = vi.fn(async () => []);
		const executor = new SherpaDiarizationExecutor({ paths, client: { call } });
		const signal = new AbortController().signal;
		await executor.diarize(
			{
				modelId: SHERPA_DIARIZATION_MODEL_ID,
				audio: { data: new Float32Array(16_000), sampleRate: 16_000 }
			},
			signal
		);
		expect(call).toHaveBeenCalledWith(
			'diarize',
			expect.objectContaining({ numSpeakers: 0 }),
			signal
		);
	});

	it('rejects invalid counts and malformed native segments', async () => {
		const request = {
			modelId: SHERPA_DIARIZATION_MODEL_ID,
			audio: { data: new Float32Array(16_000), sampleRate: 16_000 }
		};
		const signal = new AbortController().signal;
		for (const numSpeakers of [0, -1, 1.5]) {
			const executor = new SherpaDiarizationExecutor({
				paths,
				client: { call: vi.fn() }
			});
			await expect(executor.diarize({ ...request, numSpeakers }, signal)).rejects.toThrow(
				'positive integer'
			);
		}
		for (const value of [
			{},
			[{ start: -1, end: 1, speaker: 0 }],
			[{ start: 0, end: 0, speaker: 0 }],
			[{ start: 0, end: 1, speaker: -1 }],
			[{ start: 0, end: 1, speaker: '0' }]
		]) {
			const executor = new SherpaDiarizationExecutor({
				paths,
				client: { call: async () => value }
			});
			await expect(executor.diarize(request, signal)).rejects.toThrow('invalid diarization');
		}
	});
});
