import { beforeAll, describe, expect, it } from 'vitest';
import {
	audioBytes,
	collectSse,
	models,
	openai,
	parseSrt,
	parseVtt,
	postForm,
	serverIsUp
} from './helpers.ts';

// Ported from tests/api_timestamp_granularities_test.py and tests/sse_test.py.

const up = await serverIsUp();
let model: string;
let wav: Blob;

// The combinations the Python suite parametrises over.
const GRANULARITY_COMBINATIONS: ('segment' | 'word')[][] = [
	[],
	['segment'],
	['word'],
	['word', 'segment'],
	['segment', 'word']
];

describe.skipIf(!up)('transcription contract', () => {
	beforeAll(async () => {
		const found = await models();
		if (found.transcription === undefined) throw new Error('No transcription model downloaded');
		model = found.transcription;
		wav = new Blob([await audioBytes()], { type: 'audio/wav' });
	});

	describe('response formats', () => {
		it('returns json with a text field', async () => {
			const result = await openai.audio.transcriptions.create({
				file: new File([wav], 'audio.wav', { type: 'audio/wav' }),
				model,
				response_format: 'json'
			});
			expect(result.text).toBeTypeOf('string');
			expect(result.text.length).toBeGreaterThan(0);
		});

		it('returns plain text', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				response_format: 'text'
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toMatch(/\S/);
		});

		it('returns verbose_json with segments', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				response_format: 'verbose_json'
			});
			const body = (await response.json()) as {
				text: string;
				duration: number;
				language: string;
				segments: unknown[];
			};
			expect(body.text).toMatch(/\S/);
			expect(body.duration).toBeGreaterThan(0);
			expect(body.language).toBeTypeOf('string');
			expect(Array.isArray(body.segments)).toBe(true);
			expect(body.segments.length).toBeGreaterThan(0);
		});

		it('returns parseable srt as text/plain', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				response_format: 'srt'
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/plain');
			const cues = parseSrt(await response.text());
			expect(cues.length).toBeGreaterThan(0);
			expect(cues[0].index).toBe(1);
		});

		it('rejects malformed srt, proving the parser is not vacuous', () => {
			// The Python suite makes the same point with srt.SRTParseError.
			expect(() => parseSrt('YO\n00:00:00,000 --> 00:00:01,000\nhello')).toThrow();
		});

		it('returns parseable vtt as text/vtt', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				response_format: 'vtt'
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/vtt');
			const cues = parseVtt(await response.text());
			expect(cues.length).toBeGreaterThan(0);
		});

		it('rejects vtt without its header', () => {
			expect(() => parseVtt('YO\n\n00:00:00.000 --> 00:00:01.000\nhello')).toThrow();
		});
	});

	describe('timestamp granularities', () => {
		it.each(GRANULARITY_COMBINATIONS)(
			'accepts json with granularities %j',
			async (...granularities) => {
				const form = new FormData();
				form.set('file', wav, 'audio.wav');
				form.set('model', model);
				form.set('response_format', 'json');
				for (const g of granularities.flat()) form.append('timestamp_granularities[]', g);
				const response = await fetch(
					new URL(
						'/v1/audio/transcriptions',
						process.env.SPEACHY_BASE_URL ?? 'http://127.0.0.1:8001'
					),
					{ method: 'POST', body: form }
				);
				expect(response.status).toBe(200);
			}
		);

		it('includes words only when word granularity is requested', async () => {
			const request = async (granularities: string[]) => {
				const form = new FormData();
				form.set('file', wav, 'audio.wav');
				form.set('model', model);
				form.set('response_format', 'verbose_json');
				for (const g of granularities) form.append('timestamp_granularities[]', g);
				const response = await fetch(
					new URL(
						'/v1/audio/transcriptions',
						process.env.SPEACHY_BASE_URL ?? 'http://127.0.0.1:8001'
					),
					{ method: 'POST', body: form }
				);
				return (await response.json()) as { segments: unknown[] | null; words: unknown[] | null };
			};

			const withWords = await request(['segment', 'word']);
			expect(withWords.segments).not.toBeNull();
			expect(withWords.words).not.toBeNull();
			expect(withWords.words!.length).toBeGreaterThan(0);

			const withoutWords = await request(['segment']);
			expect(withoutWords.segments).not.toBeNull();
			// Unless explicitly requested, words are absent.
			expect(withoutWords.words).toBeNull();
		});
	});

	describe('streaming', () => {
		it('streams text/event-stream with non-empty data frames', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				response_format: 'text',
				stream: 'true'
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/event-stream');

			const frames = await collectSse(response);
			expect(frames.length).toBeGreaterThan(0);
			// The Python suite asserts len(event.data) > 1 because a space is
			// always prepended to whisper output.
			for (const frame of frames) expect(frame.length).toBeGreaterThan(1);
		});

		it('emits delta events that reconstruct the transcript', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				stream: 'true'
			});
			const events = (await collectSse(response)).map(
				(data) => JSON.parse(data) as { type: string; delta?: string }
			);
			const deltas = events.filter((e) => e.type === 'transcript.text.delta');
			expect(deltas.length).toBeGreaterThan(0);
			expect(deltas.map((d) => d.delta ?? '').join('')).toMatch(/\S/);
			expect(events.at(-1)?.type).toBe('transcript.text.done');
		});

		it('does not terminate the stream with a [DONE] sentinel', async () => {
			// Documented deviation from OpenAI. Pinned so a future change is visible
			// rather than silently breaking clients that wait for it.
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model,
				stream: 'true'
			});
			expect(await response.text()).not.toContain('[DONE]');
		});
	});

	describe('errors', () => {
		it('rejects a request with no model', async () => {
			const response = await postForm('/v1/audio/transcriptions', { file: wav });
			expect(response.status).toBe(422);
		});

		it('rejects an unknown model', async () => {
			const response = await postForm('/v1/audio/transcriptions', {
				file: wav,
				model: 'nope/not-a-real-model'
			});
			expect(response.status).toBeGreaterThanOrEqual(400);
		});
	});

	describe('translations', () => {
		it('returns json with a text field', async () => {
			const response = await postForm('/v1/audio/translations', {
				file: wav,
				model,
				response_format: 'json'
			});
			expect(response.status).toBe(200);
			expect(((await response.json()) as { text: string }).text).toMatch(/\S/);
		});
	});
});
