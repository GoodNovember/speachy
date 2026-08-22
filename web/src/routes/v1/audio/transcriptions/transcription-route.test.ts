import { describe, expect, it, vi } from 'vitest';
import { AudioDecodeError } from '$lib/server/audio-decode';
import { APIProxyError } from '$lib/server/errors';
import type {
	Transcription,
	TranscriptionEvent,
	TranscriptionExecutor,
	TranscriptionRequest
} from '$lib/server/executors/types';
import { _transcriptionResponse } from './+server.ts';

function executor(overrides: Partial<TranscriptionExecutor> = {}): TranscriptionExecutor {
	return {
		name: 'fixture-transcription',
		task: 'automatic-speech-recognition',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => true,
		transcribe: async () => ({ text: 'Hello, world.' }),
		async *transcribeStream(): AsyncIterable<TranscriptionEvent> {
			yield { type: 'delta', delta: ' Hello,' };
			yield { type: 'delta', delta: ' world.' };
			yield { type: 'done', text: ' Hello, world.' };
		},
		...overrides
	};
}

function transcriptionForm(responseFormat?: string): FormData {
	const form = new FormData();
	form.set('model', 'org/whisper');
	form.set('file', new Blob([new Uint8Array([1, 2])], { type: 'audio/pcm' }), 'clip.wav');
	if (responseFormat !== undefined) form.set('response_format', responseFormat);
	return form;
}

const decodedAudio = async () => ({
	data: new Float32Array(32_000),
	sampleRate: 16_000,
	name: 'clip'
});

async function sseEvents(response: Response): Promise<unknown[]> {
	return (await response.text())
		.split('\n\n')
		.filter(Boolean)
		.map((frame) => JSON.parse(frame.replace(/^data: /, '')));
}

describe('POST /v1/audio/transcriptions', () => {
	it('returns compact JSON and passes the decoded clip through the executor contract', async () => {
		const transcribe = vi.fn(async (): Promise<Transcription> => ({ text: 'Hello, world.' }));
		const form = transcriptionForm('json');
		form.set('language', 'en');
		form.set('prompt', 'Names: Speachy');
		form.set('temperature', '0.25');
		form.set('hotwords', 'Speachy');
		form.set('without_timestamps', 'false');
		form.delete('timestamp_granularities[]');
		form.append('timestamp_granularities[]', 'word');
		form.append('timestamp_granularities[]', 'segment');
		const signal = new AbortController().signal;

		const response = await _transcriptionResponse(
			form,
			signal,
			[executor({ transcribe })],
			decodedAudio
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: 'Hello, world.' });
		expect(transcribe).toHaveBeenCalledWith(
			{
				audio: expect.objectContaining({ sampleRate: 16_000, name: 'clip' }),
				model: 'org/whisper',
				language: 'en',
				prompt: 'Names: Speachy',
				responseFormat: 'json',
				temperature: 0.25,
				timestampGranularities: ['word', 'segment'],
				speechSegments: [{ start: 0, end: 32_000 }],
				vadOptions: {
					threshold: 0.5,
					minSpeechDurationMs: 0,
					maxSpeechDurationS: 30,
					minSilenceDurationMs: 160,
					speechPadMs: 400
				},
				hotwords: 'Speachy',
				withoutTimestamps: false
			},
			signal
		);
	});

	it('preserves verbose timestamps and spells absent words as null', async () => {
		const response = await _transcriptionResponse(
			transcriptionForm('verbose_json'),
			new AbortController().signal,
			[
				executor({
					transcribe: async () => ({
						text: 'Hello, world.',
						language: 'en',
						duration: 2,
						segments: [{ id: 0, start: 0.1, end: 1.5, text: ' Hello, world.' }]
					})
				})
			],
			decodedAudio
		);

		expect(await response.json()).toEqual({
			text: 'Hello, world.',
			language: 'en',
			duration: 2,
			segments: [{ id: 0, start: 0.1, end: 1.5, text: ' Hello, world.' }],
			words: null
		});
	});

	it.each([
		['text', 'text/plain', 'plain transcript'],
		['srt', 'text/plain', '1\n00:00:00,000 --> 00:00:01,000\nhello\n\n'],
		['vtt', 'text/vtt', 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n\n']
	])('returns %s using the reference media type', async (format, contentType, text) => {
		const response = await _transcriptionResponse(
			transcriptionForm(format),
			new AbortController().signal,
			[executor({ transcribe: async () => ({ text }) })],
			decodedAudio
		);
		expect(response.headers.get('content-type')).toContain(contentType);
		expect(await response.text()).toBe(text);
	});

	it('maps executor stream events to the reference SSE contract without [DONE]', async () => {
		const form = transcriptionForm();
		form.set('stream', 'true');
		const response = await _transcriptionResponse(
			form,
			new AbortController().signal,
			[executor()],
			decodedAudio
		);

		expect(response.headers.get('content-type')).toContain('text/event-stream');
		expect(await sseEvents(response)).toEqual([
			{ type: 'transcript.text.delta', delta: ' Hello,' },
			{ type: 'transcript.text.delta', delta: ' world.' },
			{ type: 'transcript.text.done', text: '' }
		]);
	});

	it('returns structured validation errors for fields, formats, granularities, and booleans', async () => {
		const signal = new AbortController().signal;
		const missingModel = await _transcriptionResponse(new FormData(), signal, []);
		expect(missingModel.status).toBe(422);
		expect(await missingModel.json()).toMatchObject({ detail: [{ loc: ['body', 'model'] }] });

		const badFormat = transcriptionForm('xml');
		const invalidFormat = await _transcriptionResponse(badFormat, signal, []);
		expect(invalidFormat.status).toBe(422);
		expect(await invalidFormat.json()).toMatchObject({
			detail: [{ loc: ['body', 'response_format'] }]
		});

		const badGranularity = transcriptionForm();
		badGranularity.append('timestamp_granularities[]', 'word');
		badGranularity.append('timestamp_granularities[]', 'word');
		const invalidGranularity = await _transcriptionResponse(badGranularity, signal, []);
		expect(invalidGranularity.status).toBe(422);
		expect(await invalidGranularity.json()).toMatchObject({
			detail: [{ loc: ['body', 'timestamp_granularities[]'] }]
		});

		const badStream = transcriptionForm();
		badStream.set('stream', 'sometimes');
		const invalidStream = await _transcriptionResponse(badStream, signal, []);
		expect(invalidStream.status).toBe(422);
		expect(await invalidStream.json()).toMatchObject({
			detail: [{ loc: ['body', 'stream'] }]
		});
	});

	it('returns 404 without decoding when no installed executor handles the model', async () => {
		const decode = vi.fn();
		const response = await _transcriptionResponse(
			transcriptionForm(),
			new AbortController().signal,
			[executor({ canHandle: async () => false })],
			decode
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ detail: "Model 'org/whisper' not found" });
		expect(decode).not.toHaveBeenCalled();
	});

	it('preserves public decode errors and hides unexpected inference failures', async () => {
		const decodeFailure = await _transcriptionResponse(
			transcriptionForm(),
			new AbortController().signal,
			[executor()],
			async () => {
				throw new AudioDecodeError('unsupported fixture', 415);
			}
		);
		expect(decodeFailure.status).toBe(415);
		expect(await decodeFailure.json()).toEqual({ detail: 'unsupported fixture' });

		await expect(
			_transcriptionResponse(
				transcriptionForm(),
				new AbortController().signal,
				[
					executor({
						transcribe: async (_request: TranscriptionRequest) => {
							throw new Error('native crash');
						}
					})
				],
				decodedAudio
			)
		).rejects.toBeInstanceOf(APIProxyError);
	});
});
