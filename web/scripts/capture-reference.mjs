import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Captures real responses from the Python reference server so the port has
// something concrete to match. Everything written here is observed behaviour,
// not a reading of the source.
//
//   node scripts/capture-reference.mjs http://127.0.0.1:8001

const BASE = process.argv[2] ?? 'http://127.0.0.1:8001';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'python-reference');
const AUDIO = join(HERE, '..', '..', 'audio.wav');

const STT_MODEL = 'Systran/faster-whisper-tiny';
const TTS_MODEL = 'speaches-ai/Kokoro-82M-v1.0-ONNX';
const TTS_VOICE = 'af_heart';

const results = [];
let audioBytes;

function record(name, entry) {
	results.push({ name, ...entry });
	const status = entry.error ? `ERROR ${entry.error}` : `${entry.status}`;
	console.log(`${status.padEnd(22)} ${name}`);
}

function headersOf(response) {
	return {
		'content-type': response.headers.get('content-type'),
		'transfer-encoding': response.headers.get('transfer-encoding')
	};
}

async function capture(name, request) {
	try {
		const response = await request();
		const contentType = response.headers.get('content-type') ?? '';
		const entry = { status: response.status, headers: headersOf(response) };

		if (contentType.includes('application/json')) {
			entry.json = await response.json();
		} else if (contentType.startsWith('audio/') || contentType.includes('octet-stream')) {
			const buffer = new Uint8Array(await response.arrayBuffer());
			// Audio bodies are large and not worth diffing byte for byte; the
			// header and the leading magic bytes are what a client actually keys on.
			entry.binary = {
				byteLength: buffer.byteLength,
				leadingBytesHex: [...buffer.slice(0, 16)]
					.map((b) => b.toString(16).padStart(2, '0'))
					.join(' ')
			};
		} else {
			const text = await response.text();
			// Keep SSE verbatim. The exact framing is the thing we must reproduce.
			entry.text = text.length > 20_000 ? `${text.slice(0, 20_000)}\n...[truncated]` : text;
		}
		record(name, entry);
	} catch (error) {
		record(name, { error: error instanceof Error ? error.message : String(error) });
	}
}

function transcriptionForm(extra = {}) {
	const form = new FormData();
	form.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
	form.set('model', STT_MODEL);
	for (const [key, value] of Object.entries(extra)) form.set(key, String(value));
	return form;
}

const post = (path, body, isForm = false) =>
	fetch(new URL(path, BASE), {
		method: 'POST',
		body: isForm ? body : JSON.stringify(body),
		headers: isForm ? undefined : { 'content-type': 'application/json' }
	});

async function main() {
	audioBytes = await readFile(AUDIO);
	console.log(`Reference: ${BASE}`);
	console.log(`Input: audio.wav (${audioBytes.byteLength} bytes)\n`);

	// --- discovery -------------------------------------------------------
	await capture('GET /health', () => fetch(new URL('/health', BASE)));
	await capture('GET /v1/models', () => fetch(new URL('/v1/models', BASE)));
	await capture('GET /v1/models?task=text-to-speech', () =>
		fetch(new URL('/v1/models?task=text-to-speech', BASE))
	);
	await capture('GET /v1/audio/models', () => fetch(new URL('/v1/audio/models', BASE)));
	await capture('GET /v1/audio/voices', () => fetch(new URL('/v1/audio/voices', BASE)));
	await capture(`GET /v1/models/${STT_MODEL}`, () =>
		fetch(new URL(`/v1/models/${STT_MODEL}`, BASE))
	);
	await capture('GET /v1/models/does-not-exist (404 shape)', () =>
		fetch(new URL('/v1/models/does-not-exist', BASE))
	);
	await capture('GET /api/ps', () => fetch(new URL('/api/ps', BASE)));

	// --- transcription ---------------------------------------------------
	for (const format of ['json', 'text', 'verbose_json', 'srt', 'vtt']) {
		await capture(`POST /v1/audio/transcriptions (${format})`, () =>
			post('/v1/audio/transcriptions', transcriptionForm({ response_format: format }), true)
		);
	}

	await capture('POST /v1/audio/transcriptions (stream sse)', () =>
		post('/v1/audio/transcriptions', transcriptionForm({ stream: 'true' }), true)
	);

	// The alias on this form field does not work in FastAPI, so the server
	// re-reads the raw form. Worth confirming the bracketed name is what lands.
	await capture('POST /v1/audio/transcriptions (word timestamps)', () => {
		const form = transcriptionForm({ response_format: 'verbose_json' });
		form.append('timestamp_granularities[]', 'word');
		form.append('timestamp_granularities[]', 'segment');
		return post('/v1/audio/transcriptions', form, true);
	});

	await capture('POST /v1/audio/transcriptions (missing model, 422 shape)', () => {
		const form = new FormData();
		form.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
		return post('/v1/audio/transcriptions', form, true);
	});

	await capture('POST /v1/audio/translations (json)', () =>
		post('/v1/audio/translations', transcriptionForm({ response_format: 'json' }), true)
	);

	// --- vad -------------------------------------------------------------
	await capture('POST /v1/audio/speech/timestamps', () => {
		const form = new FormData();
		form.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
		return post('/v1/audio/speech/timestamps', form, true);
	});

	// --- speech ----------------------------------------------------------
	for (const format of ['wav', 'pcm', 'mp3']) {
		await capture(`POST /v1/audio/speech (${format})`, () =>
			post('/v1/audio/speech', {
				model: TTS_MODEL,
				voice: TTS_VOICE,
				input: 'The quick brown fox jumps over the lazy dog.',
				response_format: format
			})
		);
	}

	await capture('POST /v1/audio/speech (stream_format sse)', () =>
		post('/v1/audio/speech', {
			model: TTS_MODEL,
			voice: TTS_VOICE,
			input: 'Streaming speech.',
			stream_format: 'sse'
		})
	);

	await capture('POST /v1/audio/speech (bad speed, 422 shape)', () =>
		post('/v1/audio/speech', {
			model: TTS_MODEL,
			voice: TTS_VOICE,
			input: 'too fast',
			speed: 9
		})
	);

	await mkdir(OUT, { recursive: true });
	const outFile = join(OUT, 'endpoints.json');
	await writeFile(outFile, `${JSON.stringify({ base: BASE, results }, null, 2)}\n`, 'utf8');

	const failed = results.filter((r) => r.error !== undefined).length;
	console.log(`\nWrote ${results.length} captures to ${outFile}`);
	if (failed > 0) console.log(`${failed} request(s) failed to connect.`);
}

await main();
