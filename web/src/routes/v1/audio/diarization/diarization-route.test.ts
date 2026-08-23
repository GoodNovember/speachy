import { describe, expect, it, vi } from 'vitest';
import { AudioDecodeError } from '$lib/server/audio-decode';
import { APIProxyError } from '$lib/server/errors';
import type { DiarizationExecutor } from '$lib/server/executors/types';
import { _diarizationResponse } from './+server.ts';

function executor(overrides: Partial<DiarizationExecutor> = {}): DiarizationExecutor {
	return {
		name: 'fixture-diarization',
		task: 'speaker-diarization',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => true,
		diarize: async () => [
			{ start: 0.125, end: 1.5, speaker: 'SPEAKER_00' },
			{ start: 1.75, end: 2, speaker: 'SPEAKER_01' }
		],
		...overrides
	};
}

function diarizationForm(responseFormat?: 'json' | 'rttm'): FormData {
	const form = new FormData();
	form.set('model', 'org/pyannote');
	form.set('file', new Blob([new Uint8Array([1, 2])], { type: 'audio/pcm' }), 'clip.wav');
	if (responseFormat !== undefined) form.set('response_format', responseFormat);
	return form;
}

const decodedAudio = async () => ({
	data: new Float32Array(32_000),
	sampleRate: 16_000,
	name: 'clip'
});

describe('POST /v1/audio/diarization', () => {
	it('returns duration and timestamped segments as JSON by default', async () => {
		const diarize = vi.fn(async () => [
			{ start: 0.125, end: 1.5, speaker: 'SPEAKER_00' },
			{ start: 1.75, end: 2, speaker: 'SPEAKER_01' }
		]);
		const signal = new AbortController().signal;
		const response = await _diarizationResponse(
			diarizationForm(),
			signal,
			[executor({ diarize })],
			decodedAudio
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			duration: 2,
			segments: [
				{ start: 0.125, end: 1.5, speaker: 'SPEAKER_00' },
				{ start: 1.75, end: 2, speaker: 'SPEAKER_01' }
			]
		});
		expect(diarize).toHaveBeenCalledWith(
			{
				modelId: 'org/pyannote',
				audio: expect.objectContaining({ sampleRate: 16_000, name: 'clip' })
			},
			signal
		);
	});

	it('forwards an optional fixed speaker count', async () => {
		const diarize = vi.fn(async () => []);
		const form = diarizationForm();
		form.set('num_speakers', '2');
		const signal = new AbortController().signal;
		const response = await _diarizationResponse(
			form,
			signal,
			[executor({ diarize })],
			decodedAudio
		);
		expect(response.status).toBe(200);
		expect(diarize).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: 'org/pyannote', numSpeakers: 2 }),
			signal
		);
	});

	it('formats segments as RTTM with the uploaded file stem', async () => {
		const response = await _diarizationResponse(
			diarizationForm('rttm'),
			new AbortController().signal,
			[executor()],
			decodedAudio
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(await response.text()).toBe(
			'SPEAKER clip 1 0.125 1.375 <NA> <NA> SPEAKER_00 <NA> <NA>\n' +
				'SPEAKER clip 1 1.750 0.250 <NA> <NA> SPEAKER_01 <NA> <NA>'
		);
	});

	it('returns structured validation errors for missing fields and formats', async () => {
		const signal = new AbortController().signal;
		const missingModel = await _diarizationResponse(new FormData(), signal, []);
		expect(missingModel.status).toBe(422);
		expect(await missingModel.json()).toMatchObject({ detail: [{ loc: ['body', 'model'] }] });

		const missingFileForm = new FormData();
		missingFileForm.set('model', 'org/pyannote');
		const missingFile = await _diarizationResponse(missingFileForm, signal, []);
		expect(missingFile.status).toBe(422);
		expect(await missingFile.json()).toMatchObject({ detail: [{ loc: ['body', 'file'] }] });

		const badFormat = diarizationForm();
		badFormat.set('response_format', 'xml');
		const invalid = await _diarizationResponse(badFormat, signal, []);
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({
			detail: [{ loc: ['body', 'response_format'] }]
		});

		for (const value of ['0', '-1', '1.5', 'two']) {
			const form = diarizationForm();
			form.set('num_speakers', value);
			const invalidCount = await _diarizationResponse(form, signal, []);
			expect(invalidCount.status).toBe(422);
			expect(await invalidCount.json()).toMatchObject({
				detail: [{ loc: ['body', 'num_speakers'] }]
			});
		}
	});

	it('returns 404 without decoding when no installed executor handles the model', async () => {
		const decode = vi.fn();
		const response = await _diarizationResponse(
			diarizationForm(),
			new AbortController().signal,
			[executor({ canHandle: async () => false })],
			decode
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ detail: "Model 'org/pyannote' not found" });
		expect(decode).not.toHaveBeenCalled();
	});

	it('rejects known-speaker mapping explicitly until the executor contract supports it', async () => {
		const form = diarizationForm();
		form.set('known_speaker_names[]', 'Alice');
		form.set('known_speaker_references[]', 'data:audio/wav;base64,fixture');
		const response = await _diarizationResponse(
			form,
			new AbortController().signal,
			[executor()],
			vi.fn()
		);
		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			detail:
				'Known-speaker reference mapping is not supported by the SvelteKit diarization endpoint yet'
		});
	});

	it('preserves public decode errors and hides unexpected inference failures', async () => {
		const decodeFailure = await _diarizationResponse(
			diarizationForm(),
			new AbortController().signal,
			[executor()],
			async () => {
				throw new AudioDecodeError('unsupported fixture', 415);
			}
		);
		expect(decodeFailure.status).toBe(415);
		expect(await decodeFailure.json()).toEqual({ detail: 'unsupported fixture' });

		await expect(
			_diarizationResponse(
				diarizationForm(),
				new AbortController().signal,
				[
					executor({
						diarize: async () => {
							throw new Error('native crash');
						}
					})
				],
				decodedAudio
			)
		).rejects.toBeInstanceOf(APIProxyError);
	});
});
