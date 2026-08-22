import { beforeAll, describe, expect, it } from 'vitest';
import {
	audioBytes,
	cosineSimilarity,
	models,
	postForm,
	repeatPcm16Wav,
	serverIsUp,
	sinePcm16Wav
} from './helpers.ts';

// Ported from tests/speech_embedding_test.py and tests/diarization_test.py.

const up = await serverIsUp();
let embeddingModel: string;
let diarizationModel: string;
let shortWav: Blob;
let diarizationWav: Blob;
let sineWav: Blob;

type EmbeddingResponse = {
	object: string;
	model: string;
	data: { object: string; embedding: number[]; index: number }[];
	usage: { prompt_tokens: number; total_tokens: number };
};

type DiarizationResponse = {
	duration: number;
	segments: { start: number; end: number; speaker: string }[];
};

describe.skipIf(!up)('embedding and diarization contracts', () => {
	beforeAll(async () => {
		const found = await models();
		if (found.speakerEmbedding === undefined) {
			throw new Error('No speaker-embedding model downloaded');
		}
		if (found.diarization === undefined) {
			throw new Error('No speaker-diarization model downloaded');
		}
		embeddingModel = found.speakerEmbedding;
		diarizationModel = found.diarization;
		const fixture = await audioBytes();
		shortWav = new Blob([fixture], { type: 'audio/wav' });
		diarizationWav = new Blob([repeatPcm16Wav(fixture, 10)], { type: 'audio/wav' });
		sineWav = new Blob([sinePcm16Wav(440, 10)], { type: 'audio/wav' });
	});

	describe('speaker embedding', () => {
		const embed = async (): Promise<Response> =>
			postForm('/v1/audio/speech/embedding', {
				file: shortWav,
				model: embeddingModel
			});

		it('returns a finite 256-value embedding envelope', async () => {
			const response = await embed();
			expect(response.status).toBe(200);
			const body = (await response.json()) as EmbeddingResponse;
			expect(body.object).toBe('list');
			expect(body.model).toBe(embeddingModel);
			expect(body.data).toHaveLength(1);
			expect(body.data[0]).toMatchObject({ object: 'embedding', index: 0 });
			expect(body.data[0]!.embedding).toHaveLength(256);
			expect(body.data[0]!.embedding.every(Number.isFinite)).toBe(true);
			expect(body.usage.prompt_tokens).toBeGreaterThan(0);
			expect(body.usage.total_tokens).toBeGreaterThan(0);
		});

		it('returns effectively identical vectors for identical audio', async () => {
			const first = await embed();
			const second = await embed();
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			const left = ((await first.json()) as EmbeddingResponse).data[0]!.embedding;
			const right = ((await second.json()) as EmbeddingResponse).data[0]!.embedding;
			expect(cosineSimilarity(left, right)).toBeGreaterThan(0.99);
		});

		it('returns 404 for an unavailable model', async () => {
			const response = await postForm('/v1/audio/speech/embedding', {
				file: shortWav,
				model: 'non-existent-model'
			});
			expect(response.status).toBe(404);
		});
	});

	describe('diarization', () => {
		it('returns bounded timestamped segments and the input duration as JSON', async () => {
			const response = await postForm('/v1/audio/diarization', {
				file: sineWav,
				model: diarizationModel,
				response_format: 'json'
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');
			const body = (await response.json()) as DiarizationResponse;
			expect(body.duration).toBeCloseTo(10, 1);
			for (const segment of body.segments) {
				expect(segment.start).toBeGreaterThanOrEqual(0);
				expect(segment.end).toBeGreaterThan(segment.start);
				expect(segment.end).toBeLessThanOrEqual(body.duration + 0.1);
				expect(segment.speaker.length).toBeGreaterThan(0);
			}
		}, 120_000);

		it('returns structurally valid RTTM', async () => {
			const response = await postForm('/v1/audio/diarization', {
				file: sineWav,
				model: diarizationModel,
				response_format: 'rttm'
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/plain');
			const text = (await response.text()).trim();
			const lines = text.length === 0 ? [] : text.split(/\r?\n/);
			for (const line of lines) {
				const parts = line.split(/\s+/);
				expect(parts).toHaveLength(10);
				expect(parts[0]).toBe('SPEAKER');
				expect(Number(parts[3])).toBeGreaterThanOrEqual(0);
				expect(Number(parts[4])).toBeGreaterThan(0);
			}
		}, 120_000);

		it('returns non-empty segments for real speech and defaults to JSON', async () => {
			const response = await postForm('/v1/audio/diarization', {
				file: diarizationWav,
				model: diarizationModel
			});
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('application/json');
			const body = (await response.json()) as DiarizationResponse;
			expect(body.duration).toBeGreaterThanOrEqual(10);
			expect(body.segments.length).toBeGreaterThan(0);
		}, 120_000);
	});
});
