import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_MODEL_ID,
	type SherpaWhisperModelPaths
} from '../native-whisper.ts';
import { SherpaWhisperTranscriptionExecutor } from './sherpa-transcription.ts';
import type { TranscriptionRequest } from './types.ts';

let directory: string;
let paths: SherpaWhisperModelPaths;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'speachy-sherpa-executor-'));
	paths = resolveSherpaWhisperModelPaths({ SPEACHY_SHERPA_WHISPER_MODEL_DIR: directory });
	await Promise.all([
		writeFile(paths.encoder, ''),
		writeFile(paths.decoder, ''),
		writeFile(paths.tokens, '')
	]);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function request(overrides: Partial<TranscriptionRequest> = {}): TranscriptionRequest {
	return {
		audio: { data: new Float32Array(16_000), sampleRate: 16_000, name: 'sample.wav' },
		model: SHERPA_WHISPER_MODEL_ID,
		responseFormat: 'json',
		temperature: 0,
		timestampGranularities: ['segment'],
		speechSegments: [{ start: 0, end: 16_000 }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: 30,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		withoutTimestamps: true,
		...overrides
	};
}

describe('SherpaWhisperTranscriptionExecutor', () => {
	it('advertises only the complete native model', async () => {
		const executor = new SherpaWhisperTranscriptionExecutor({
			paths,
			client: { call: vi.fn() }
		});
		await expect(executor.canHandle(SHERPA_WHISPER_MODEL_ID)).resolves.toBe(true);
		await expect(executor.canHandle('Systran/faster-whisper-tiny')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			expect.objectContaining({
				id: SHERPA_WHISPER_MODEL_ID,
				ownedBy: 'sherpa-onnx',
				task: 'automatic-speech-recognition',
				language: ['en']
			})
		]);
	});

	it('maps a native result into the existing transcription contract', async () => {
		const call = vi.fn(async () => ({ text: ' Hello world. ', lang: 'en' }));
		const executor = new SherpaWhisperTranscriptionExecutor({ paths, client: { call } });
		await expect(executor.transcribe(request(), new AbortController().signal)).resolves.toEqual({
			text: 'Hello world.',
			language: 'en',
			duration: 1,
			segments: [{ id: 0, start: 0, end: 1, text: 'Hello world.' }]
		});
		expect(call).toHaveBeenCalledWith(
			'transcribe',
			expect.objectContaining({ sampleRate: 16_000 }),
			expect.any(AbortSignal)
		);
	});

	it("chunks long speech ranges below sherpa Whisper's 30-second limit", async () => {
		const call = vi.fn(async (_method: string, _payload: { samples: Float32Array }) => ({
			text: ` Part ${call.mock.calls.length}. `,
			lang: 'en'
		}));
		const executor = new SherpaWhisperTranscriptionExecutor({ paths, client: { call } });
		const audio = { data: new Float32Array(600), sampleRate: 10, name: 'long.wav' };
		await expect(
			executor.transcribe(
				request({ audio, speechSegments: [{ start: 0, end: audio.data.length }] }),
				new AbortController().signal
			)
		).resolves.toEqual({
			text: 'Part 1. Part 2. Part 3.',
			language: 'en',
			duration: 60,
			segments: [
				{ id: 0, start: 0, end: 29, text: 'Part 1.' },
				{ id: 1, start: 29, end: 58, text: 'Part 2.' },
				{ id: 2, start: 58, end: 60, text: 'Part 3.' }
			]
		});
		expect(call).toHaveBeenCalledTimes(3);
		expect(call.mock.calls.map(([, payload]) => payload.samples.length)).toEqual([290, 290, 20]);
	});

	it('adapts completed native inference to the streaming contract', async () => {
		const executor = new SherpaWhisperTranscriptionExecutor({
			paths,
			client: { call: async () => ({ text: 'Hello world.' }) }
		});
		const events = [];
		for await (const event of executor.transcribeStream(request(), new AbortController().signal)) {
			events.push(event);
		}
		expect(events).toEqual([
			{ type: 'delta', delta: 'Hello world.' },
			{ type: 'done', text: 'Hello world.' }
		]);
	});

	it('rejects options that the proof does not yet implement', async () => {
		const executor = new SherpaWhisperTranscriptionExecutor({
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
