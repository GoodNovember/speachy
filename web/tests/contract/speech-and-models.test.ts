import { beforeAll, describe, expect, it } from 'vitest';
import { api, audioBytes, collectSse, models, postForm, serverIsUp } from './helpers.ts';

// Ported from tests/speech_test.py, tests/api_model_test.py and tests/vad_test.py.

const up = await serverIsUp();
let speechModel: string;
let voice: string;
let sttModel: string;

const postJson = (path: string, body: unknown) =>
	fetch(api(path), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});

describe.skipIf(!up)('speech contract', () => {
	beforeAll(async () => {
		const found = await models();
		if (found.speech === undefined || found.voice === undefined) {
			throw new Error('No text-to-speech model or voice available');
		}
		speechModel = found.speech;
		voice = found.voice;
	});

	it('returns wav with a RIFF header', async () => {
		const response = await postJson('/v1/audio/speech', {
			model: speechModel,
			voice,
			input: 'The quick brown fox.',
			response_format: 'wav'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('audio/wav');
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
		expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
	});

	it('returns mp3 with an id3 or frame-sync header', async () => {
		const response = await postJson('/v1/audio/speech', {
			model: speechModel,
			voice,
			input: 'The quick brown fox.',
			response_format: 'mp3'
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('audio/mpeg');
		const bytes = new Uint8Array(await response.arrayBuffer());
		const isId3 = String.fromCharCode(...bytes.slice(0, 3)) === 'ID3';
		const isFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
		expect(isId3 || isFrameSync).toBe(true);
	});

	it('returns raw pcm with no container', async () => {
		const response = await postJson('/v1/audio/speech', {
			model: speechModel,
			voice,
			input: 'The quick brown fox.',
			response_format: 'pcm'
		});
		expect(response.status).toBe(200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(bytes.byteLength).toBeGreaterThan(1000);
		expect(String.fromCharCode(...bytes.slice(0, 4))).not.toBe('RIFF');
	});

	it('streams audio deltas over sse', async () => {
		const response = await postJson('/v1/audio/speech', {
			model: speechModel,
			voice,
			input: 'Streaming speech.',
			stream_format: 'sse'
		});
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const events = (await collectSse(response)).map(
			(data) => JSON.parse(data) as { type: string; audio?: string }
		);
		const deltas = events.filter((e) => e.type === 'speech.audio.delta');
		expect(deltas.length).toBeGreaterThan(0);
		expect((deltas[0].audio ?? '').length).toBeGreaterThan(0);
	});

	// Everything validated inside handle_speech_request is checked lazily, once
	// StreamingResponse starts consuming the generator -- which is after the 200
	// and its headers have gone out. The client gets a severed connection rather
	// than an error. These tests pin that behaviour rather than assert it is
	// correct: our implementation must validate eagerly and return 4xx, at which
	// point these two flip and should be rewritten.
	const expectSeveredNotRejected = async (body: Record<string, unknown>) => {
		const response = await postJson('/v1/audio/speech', body);
		expect(response.status).toBe(200);
		// Either the body arrives empty or reading it throws, depending on how the
		// runtime surfaces a connection cut mid-stream. Both mean severed.
		const severed = await response.arrayBuffer().then(
			(buffer) => buffer.byteLength === 0,
			() => true
		);
		expect(severed).toBe(true);
	};

	it('severs the connection on an unsupported voice instead of rejecting it', async () => {
		await expectSeveredNotRejected({
			model: speechModel,
			voice: 'definitely-not-a-voice',
			input: 'hello'
		});
	});

	it('severs the connection on an out-of-range speed instead of rejecting it', async () => {
		await expectSeveredNotRejected({
			model: speechModel,
			voice,
			input: 'hello',
			speed: 9
		});
	});
});

describe.skipIf(!up)('models contract', () => {
	it('lists local models as an object list', async () => {
		const response = await fetch(api('/v1/models'));
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { id: string; object?: string }[] };
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBeGreaterThan(0);
		expect(body.data[0].id).toBeTypeOf('string');
	});

	it('filters by task', async () => {
		const response = await fetch(api('/v1/models?task=text-to-speech'));
		const body = (await response.json()) as { data: { task?: string }[] };
		expect(body.data.length).toBeGreaterThan(0);
		expect(body.data.every((m) => m.task === 'text-to-speech')).toBe(true);
	});

	it('retrieves a single model by id, including slashes in the path', async () => {
		const found = await models();
		const response = await fetch(api(`/v1/models/${found.transcription}`));
		expect(response.status).toBe(200);
		expect(((await response.json()) as { id: string }).id).toBe(found.transcription);
	});

	it('returns 404 for an unknown model', async () => {
		const response = await fetch(api('/v1/models/does-not-exist'));
		expect(response.status).toBe(404);
		expect(((await response.json()) as { detail: string }).detail).toContain('not found');
	});

	it('lists voices', async () => {
		const response = await fetch(api('/v1/audio/voices'));
		const body = (await response.json()) as { voices: { name?: string }[] };
		expect(body.voices.length).toBeGreaterThan(0);
	});

	it('reports loaded models', async () => {
		const response = await fetch(api('/api/ps'));
		expect(response.status).toBe(200);
		expect(Array.isArray(((await response.json()) as { models: string[] }).models)).toBe(true);
	});

	it('serves a health check without authentication', async () => {
		const response = await fetch(api('/health'));
		expect(response.status).toBe(200);
	});
});

describe.skipIf(!up)('voice activity detection contract', () => {
	beforeAll(async () => {
		const found = await models();
		sttModel = found.transcription ?? '';
	});

	it('returns speech timestamps as integer milliseconds', async () => {
		const wav = new Blob([await audioBytes()], { type: 'audio/wav' });
		const response = await postForm('/v1/audio/speech/timestamps', { file: wav });
		expect(response.status).toBe(200);
		const timestamps = (await response.json()) as { start: number; end: number }[];
		expect(timestamps.length).toBeGreaterThan(0);
		for (const stamp of timestamps) {
			expect(Number.isInteger(stamp.start)).toBe(true);
			expect(Number.isInteger(stamp.end)).toBe(true);
			expect(stamp.end).toBeGreaterThan(stamp.start);
		}
		expect(sttModel).toBeTypeOf('string');
	});
});
