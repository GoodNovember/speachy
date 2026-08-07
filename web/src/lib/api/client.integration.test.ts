import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SpeachyClient } from './client.ts';
import { ApiError } from './errors.ts';

// Runs against the live Python reference. Start it with
//   pwsh web/scripts/run-reference.ps1
// and the suite skips itself when it is not listening.

const BASE = process.env.SPEACHY_REFERENCE_URL ?? 'http://127.0.0.1:8000';
const STT_MODEL = 'Systran/faster-whisper-tiny';
const TTS_MODEL = 'speaches-ai/Kokoro-82M-v1.0-ONNX';

const reachable = await fetch(new URL('/health', BASE), {
	signal: AbortSignal.timeout(2000)
})
	.then((r) => r.ok)
	.catch(() => false);

const client = new SpeachyClient({ baseUrl: BASE });
let audio: Blob;

describe.skipIf(!reachable)('SpeachyClient against the reference server', () => {
	beforeAll(async () => {
		const bytes = await readFile(fileURLToPath(new URL('../../../../audio.wav', import.meta.url)));
		audio = new Blob([bytes], { type: 'audio/wav' });
	});

	it('lists local models', async () => {
		const models = await client.listModels();
		expect(models.map((m) => m.id)).toContain(STT_MODEL);
	});

	it('filters models by task', async () => {
		const models = await client.listModels('text-to-speech');
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((m) => m.task === 'text-to-speech')).toBe(true);
	});

	it('lists voices', async () => {
		const voices = await client.listVoices();
		expect(voices.some((v) => v.name === 'af_heart')).toBe(true);
	});

	it('transcribes to plain json', async () => {
		await expect(client.transcribe({ file: audio, model: STT_MODEL })).resolves.toBe(
			'Hello, world.'
		);
	});

	it('transcribes to text, keeping whisper leading space', async () => {
		const text = await client.transcribe({
			file: audio,
			model: STT_MODEL,
			responseFormat: 'text'
		});
		expect(text).toContain('Hello, world.');
	});

	it('returns segments and word timings in verbose mode', async () => {
		const result = await client.transcribeVerbose({
			file: audio,
			model: STT_MODEL,
			wordTimestamps: true
		});
		expect(result.text).toBe('Hello, world.');
		expect(result.language).toBe('en');
		expect(result.segments?.length).toBeGreaterThan(0);
		// Words land at the top level, not nested inside segments.
		expect(result.words?.map((w) => w.word.trim())).toEqual(['Hello,', 'world.']);
	});

	it('streams transcription deltas and terminates without a [DONE] sentinel', async () => {
		const events = [];
		for await (const event of client.transcribeStream({ file: audio, model: STT_MODEL })) {
			events.push(event);
		}
		const deltas = events.filter((e) => e.type === 'transcript.text.delta');
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.map((d) => d.delta).join('')).toContain('Hello, world.');
		expect(events.at(-1)?.type).toBe('transcript.text.done');
	});

	it('pins the upstream bug: done reports an empty transcript', async () => {
		// Documented in tests/fixtures/python-reference/FINDINGS.md. If this ever
		// starts failing, upstream fixed it and our port should follow.
		const events = [];
		for await (const event of client.transcribeStream({ file: audio, model: STT_MODEL })) {
			events.push(event);
		}
		const done = events.find((e) => e.type === 'transcript.text.done');
		expect(done?.text).toBe('');
	});

	it('detects speech timestamps in integer milliseconds', async () => {
		const timestamps = await client.detectSpeech(audio);
		expect(timestamps.length).toBeGreaterThan(0);
		expect(Number.isInteger(timestamps[0].start)).toBe(true);
		expect(timestamps[0].end).toBeGreaterThan(timestamps[0].start);
	});

	it('synthesizes wav audio', async () => {
		const blob = await client.synthesize({
			model: TTS_MODEL,
			voice: 'af_heart',
			input: 'Testing one two three.',
			responseFormat: 'wav'
		});
		expect(blob.size).toBeGreaterThan(1000);
		const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
		expect(String.fromCharCode(...header)).toBe('RIFF');
	});

	it('streams synthesized audio chunks', async () => {
		let total = 0;
		for await (const chunk of client.synthesizeStream({
			model: TTS_MODEL,
			voice: 'af_heart',
			input: 'Streaming audio test.'
		})) {
			total += chunk.byteLength;
		}
		expect(total).toBeGreaterThan(1000);
	});

	it('surfaces a 404 as an ApiError with the server message', async () => {
		const failure = client.transcribe({ file: audio, model: 'nope/not-a-model' });
		await expect(failure).rejects.toBeInstanceOf(ApiError);
		await expect(failure).rejects.toMatchObject({ status: expect.any(Number) });
	});
});
