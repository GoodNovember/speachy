import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveSherpaParakeetModelPaths,
	SHERPA_PARAKEET_MODEL_ID,
	type SherpaParakeetModelPaths
} from '../native-parakeet.ts';
import {
	mapParakeetWordTimestamps,
	SherpaParakeetTranscriptionExecutor
} from './sherpa-parakeet-transcription.ts';
import type { TranscriptionRequest } from './types.ts';

let directory: string;
let paths: SherpaParakeetModelPaths;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'speachy-parakeet-executor-'));
	paths = resolveSherpaParakeetModelPaths({ SPEACHY_SHERPA_PARAKEET_MODEL_DIR: directory });
	await Promise.all([
		writeFile(paths.encoder, ''),
		writeFile(paths.decoder, ''),
		writeFile(paths.joiner, ''),
		writeFile(paths.tokens, '')
	]);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function request(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
	return {
		audio: { data: new Float32Array(16_000), sampleRate: 16_000, name: 'sample.wav' },
		model: SHERPA_PARAKEET_MODEL_ID,
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment', 'word'],
		speechSegments: [{ start: 0, end: 16_000 }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: 30,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		withoutTimestamps: false,
		...overrides
	};
}

describe('Parakeet timestamp mapping', () => {
	it('groups BPE tokens into monotonic word spans', () => {
		expect(
			mapParakeetWordTimestamps(
				{
					text: 'Ask not bad.',
					tokens: [' A', 'sk', ' not', ' bad', '.'],
					timestamps: [0, 0.08, 0.4, 0.8, 0.96]
				},
				10,
				11
			)
		).toEqual([
			{ word: 'Ask', start: 10, end: 10.4 },
			{ word: 'not', start: 10.4, end: 10.8 },
			{ word: 'bad.', start: 10.8, end: 11 }
		]);
	});

	it('refuses malformed timestamp arrays rather than fabricating words', () => {
		expect(
			mapParakeetWordTimestamps({ text: 'Ask', tokens: [' A', 'sk'], timestamps: [0.2, 0.1] }, 0, 1)
		).toBeUndefined();
	});
});

describe('SherpaParakeetTranscriptionExecutor', () => {
	it('advertises only the complete native model', async () => {
		const executor = new SherpaParakeetTranscriptionExecutor({
			paths,
			client: { call: vi.fn() }
		});
		await expect(executor.canHandle(SHERPA_PARAKEET_MODEL_ID)).resolves.toBe(true);
		await expect(executor.canHandle('istupakov/parakeet-tdt')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			expect.objectContaining({
				id: SHERPA_PARAKEET_MODEL_ID,
				ownedBy: 'sherpa-onnx',
				task: 'automatic-speech-recognition',
				language: ['en']
			})
		]);
	});

	it('maps native text and token timestamps into the transcription contract', async () => {
		const call = vi.fn(async () => ({
			text: ' Hello world.',
			lang: '',
			tokens: [' Hello', ' world', '.'],
			timestamps: [0.08, 0.48, 0.88],
			durations: []
		}));
		const executor = new SherpaParakeetTranscriptionExecutor({ paths, client: { call } });
		await expect(executor.transcribe(request(), new AbortController().signal)).resolves.toEqual({
			text: 'Hello world.',
			language: 'en',
			duration: 1,
			segments: [
				{
					id: 0,
					start: 0,
					end: 1,
					text: 'Hello world.',
					words: [
						{ word: 'Hello', start: 0.08, end: 0.48 },
						{ word: 'world.', start: 0.48, end: 1 }
					]
				}
			],
			words: [
				{ word: 'Hello', start: 0.08, end: 0.48 },
				{ word: 'world.', start: 0.48, end: 1 }
			]
		});
		expect(call).toHaveBeenCalledOnce();
	});

	it('rejects unsupported language and prompt options', async () => {
		const executor = new SherpaParakeetTranscriptionExecutor({
			paths,
			client: { call: vi.fn() }
		});
		await expect(
			executor.transcribe(request({ language: 'fr' }), new AbortController().signal)
		).rejects.toThrow(/only supports English/);
		await expect(
			executor.transcribe(request({ prompt: 'Names' }), new AbortController().signal)
		).rejects.toThrow(/prompts or hotwords/);
	});
});
