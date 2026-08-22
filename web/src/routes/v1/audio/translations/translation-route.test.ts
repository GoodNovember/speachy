import { describe, expect, it, vi } from 'vitest';
import { APIProxyError } from '$lib/server/errors';
import type { TranscriptionEvent, TranscriptionExecutor } from '$lib/server/executors/types';
import { _translationResponse } from './+server.ts';

function executor(overrides: Partial<TranscriptionExecutor> = {}): TranscriptionExecutor {
	return {
		name: 'fixture-translation',
		task: 'automatic-speech-recognition',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => true,
		transcribe: async () => ({ text: '' }),
		async *transcribeStream(): AsyncIterable<TranscriptionEvent> {
			yield { type: 'done', text: '' };
		},
		translate: async () => ({ text: 'Hello, world.' }),
		...overrides
	};
}

function translationForm(responseFormat?: string): FormData {
	const form = new FormData();
	form.set('model', 'org/whisper');
	form.set('file', new Blob([new Uint8Array([1, 2])], { type: 'audio/pcm' }), 'clip.wav');
	if (responseFormat !== undefined) form.set('response_format', responseFormat);
	return form;
}

const decodedAudio = async () => ({
	data: new Float32Array(16_000),
	sampleRate: 16_000,
	name: 'clip'
});

describe('POST /v1/audio/translations', () => {
	it('returns JSON and passes translation-specific inputs through the executor contract', async () => {
		const translate = vi.fn(async () => ({ text: 'Hello, world.' }));
		const form = translationForm('json');
		form.set('prompt', 'Translate this');
		form.set('temperature', '0.5');
		const signal = new AbortController().signal;

		const response = await _translationResponse(
			form,
			signal,
			[executor({ translate })],
			decodedAudio
		);

		expect(await response.json()).toEqual({ text: 'Hello, world.' });
		expect(translate).toHaveBeenCalledWith(
			{
				audio: expect.objectContaining({ sampleRate: 16_000, name: 'clip' }),
				model: 'org/whisper',
				prompt: 'Translate this',
				responseFormat: 'json',
				temperature: 0.5,
				speechSegments: [{ start: 0, end: 16_000 }],
				vadOptions: {
					threshold: 0.5,
					minSpeechDurationMs: 0,
					maxSpeechDurationS: 30,
					minSilenceDurationMs: 160,
					speechPadMs: 400
				}
			},
			signal
		);
	});

	it('uses the same verbose and subtitle serializers as transcription', async () => {
		const verbose = await _translationResponse(
			translationForm('verbose_json'),
			new AbortController().signal,
			[
				executor({
					translate: async () => ({
						text: 'Hello.',
						language: 'en',
						duration: 1,
						segments: [{ id: 0, start: 0, end: 1, text: ' Hello.' }]
					})
				})
			],
			decodedAudio
		);
		expect(await verbose.json()).toMatchObject({
			text: 'Hello.',
			segments: [{ id: 0, start: 0, end: 1, text: ' Hello.' }],
			words: null
		});

		const vtt = await _translationResponse(
			translationForm('vtt'),
			new AbortController().signal,
			[executor({ translate: async () => ({ text: 'WEBVTT\n\nfixture' }) })],
			decodedAudio
		);
		expect(vtt.headers.get('content-type')).toContain('text/vtt');
		expect(await vtt.text()).toBe('WEBVTT\n\nfixture');
	});

	it('rejects unsupported executors before decoding', async () => {
		const decode = vi.fn();
		const response = await _translationResponse(
			translationForm(),
			new AbortController().signal,
			[executor({ translate: undefined })],
			decode
		);
		expect(response.status).toBe(404);
		expect(decode).not.toHaveBeenCalled();
	});

	it('hides unexpected translation failures', async () => {
		await expect(
			_translationResponse(
				translationForm(),
				new AbortController().signal,
				[
					executor({
						translate: async () => {
							throw new Error('native crash');
						}
					})
				],
				decodedAudio
			)
		).rejects.toBeInstanceOf(APIProxyError);
	});
});
