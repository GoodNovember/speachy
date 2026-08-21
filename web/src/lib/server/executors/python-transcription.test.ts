import { describe, expect, it, vi } from 'vitest';
import {
	encodeRpcAudio,
	encodeTranscriptionRequest,
	PythonTranscriptionExecutor
} from './python-transcription.ts';
import type { TranscriptionRequest } from './types.ts';

function request(): TranscriptionRequest {
	return {
		audio: { data: new Float32Array([-1, -0.25, 0.25, 1]), sampleRate: 16_000, name: 'clip' },
		model: 'org/whisper-tiny',
		language: 'en',
		prompt: 'Names: Speachy',
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment', 'word'],
		speechSegments: [{ start: 0, end: 4 }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: Number.POSITIVE_INFINITY,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		hotwords: 'speachy',
		withoutTimestamps: false
	};
}

describe('Python transcription RPC codec', () => {
	it('encodes Float32 audio as canonical little-endian base64', () => {
		const encoded = encodeRpcAudio(request().audio);
		const bytes = Buffer.from(encoded.data as string, 'base64');
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(Array.from({ length: 4 }, (_, index) => view.getFloat32(index * 4, true))).toEqual([
			-1, -0.25, 0.25, 1
		]);
		expect(encoded).toMatchObject({
			encoding: 'f32le-base64',
			sample_rate: 16_000,
			name: 'clip'
		});
	});

	it('maps the executor request to snake-case protocol fields', () => {
		expect(encodeTranscriptionRequest(request())).toMatchObject({
			model: 'org/whisper-tiny',
			response_format: 'verbose_json',
			timestamp_granularities: ['segment', 'word'],
			speech_segments: [{ start: 0, end: 4 }],
			vad_options: {
				max_speech_duration_s: null,
				min_silence_duration_ms: 160,
				speech_pad_ms: 400
			},
			without_timestamps: false
		});
	});
});

describe('PythonTranscriptionExecutor', () => {
	it('returns a validated semantic transcription and forwards cancellation', async () => {
		const rpcRequest = vi.fn(async () => ({
			text: 'hello',
			language: 'en',
			duration: 1.25,
			segments: [{ id: 0, start: 0, end: 1.25, text: 'hello' }],
			words: null
		}));
		const executor = new PythonTranscriptionExecutor({ request: rpcRequest });
		const signal = new AbortController().signal;

		await expect(executor.transcribe(request(), signal)).resolves.toEqual({
			text: 'hello',
			language: 'en',
			duration: 1.25,
			segments: [{ id: 0, start: 0, end: 1.25, text: 'hello' }]
		});
		expect(rpcRequest).toHaveBeenCalledWith('transcribe', expect.any(Object), { signal });
	});

	it('exposes only locally installed models as handleable', async () => {
		const model = {
			id: 'org/whisper-tiny',
			created: 1,
			object: 'model' as const,
			owned_by: 'org',
			language: ['en'],
			task: 'automatic-speech-recognition' as const
		};
		const executor = new PythonTranscriptionExecutor(
			{ request: vi.fn() },
			{ listLocal: async () => [model], listRemote: async () => [] }
		);
		await expect(executor.canHandle(model.id)).resolves.toBe(true);
		await expect(executor.canHandle('org/missing')).resolves.toBe(false);
		await expect(executor.listLocalModels()).resolves.toEqual([
			{
				id: model.id,
				created: 1,
				ownedBy: 'org',
				task: 'automatic-speech-recognition',
				language: ['en']
			}
		]);
	});
});
