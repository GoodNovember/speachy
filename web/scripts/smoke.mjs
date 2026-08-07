import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// Acceptance check for the app itself. Point it at the dev server or the built
// server; both should behave identically.
//   node scripts/smoke.mjs http://127.0.0.1:5173
//
// The /v1 checks require the Python reference to be running behind the proxy
// and are reported as skipped when it is not.

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';
const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIO = join(HERE, '..', '..', 'audio.wav');

const failures = [];
let skipped = 0;

function check(name, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures.push(name);
}

function skip(name, why) {
	console.log(`SKIP  ${name}  ${why}`);
	skipped += 1;
}

// --- pages ---------------------------------------------------------------

for (const [path, marker] of [
	['/', 'speachy'],
	['/stt', 'Speech to text'],
	['/tts', 'Text to speech'],
	['/mic', 'Microphone capture'],
	['/realtime', 'Realtime console'],
	['/models', 'Registry']
]) {
	const response = await fetch(new URL(path, BASE));
	const body = await response.text();
	check(`page ${path} renders`, response.status === 200 && body.includes(marker));
}

// --- realtime transport --------------------------------------------------

const received = [];
await new Promise((resolve) => {
	const url = new URL('/v1/realtime', BASE);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.searchParams.set('model', 'Systran/faster-whisper-tiny');
	url.searchParams.set('intent', 'transcription');
	const socket = new WebSocket(url);
	const timer = setTimeout(() => {
		socket.terminate();
		resolve();
	}, 8000);
	socket.on('open', () => {});
	socket.on('message', (data) => {
		const event = JSON.parse(data.toString());
		received.push(event);
		if (event.type === 'session.created') {
			clearTimeout(timer);
			socket.close();
		}
	});
	socket.on('error', () => {
		clearTimeout(timer);
		resolve();
	});
	socket.on('close', () => {
		clearTimeout(timer);
		resolve();
	});
});

check(
	'realtime socket proxies through to a real session',
	received.some((e) => e.type === 'session.created'),
	received.map((e) => e.type).join(', ') || 'no events'
);

// --- proxy to the reference ---------------------------------------------

const modelsResponse = await fetch(new URL('/v1/models', BASE));
if (modelsResponse.status === 502) {
	skip('proxy /v1/models', 'reference server not running');
	skip('proxy transcription', 'reference server not running');
	skip('proxy streaming transcription', 'reference server not running');
} else {
	const models = await modelsResponse.json();
	check(
		'proxy /v1/models reaches the reference',
		modelsResponse.status === 200 && Array.isArray(models.data) && models.data.length > 0,
		`${models.data?.length ?? 0} models`
	);

	const sttModel = models.data.find((m) => m.task === 'automatic-speech-recognition')?.id;
	const audioBytes = await readFile(AUDIO);

	if (sttModel === undefined) {
		skip('proxy transcription', 'no speech-to-text model downloaded');
		skip('proxy streaming transcription', 'no speech-to-text model downloaded');
	} else {
		const form = new FormData();
		form.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
		form.set('model', sttModel);
		const transcription = await fetch(new URL('/v1/audio/transcriptions', BASE), {
			method: 'POST',
			body: form
		});
		const json = await transcription.json();
		check(
			'proxy transcription returns text',
			typeof json.text === 'string' && json.text.length > 0,
			json.text
		);

		const streamForm = new FormData();
		streamForm.set('file', new Blob([audioBytes], { type: 'audio/wav' }), 'audio.wav');
		streamForm.set('model', sttModel);
		streamForm.set('stream', 'true');
		const streamed = await fetch(new URL('/v1/audio/transcriptions', BASE), {
			method: 'POST',
			body: streamForm
		});
		const text = await streamed.text();
		check(
			'proxy streams SSE without buffering into JSON',
			streamed.headers.get('content-type')?.includes('text/event-stream') === true &&
				text.includes('transcript.text.delta')
		);
	}

	const ttsModel = models.data.find((m) => m.task === 'text-to-speech')?.id;
	if (ttsModel === undefined) {
		skip('proxy speech synthesis', 'no text-to-speech model downloaded');
	} else {
		const speech = await fetch(new URL('/v1/audio/speech', BASE), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: ttsModel,
				voice: 'af_heart',
				input: 'Smoke test.',
				response_format: 'wav'
			})
		});
		const bytes = new Uint8Array(await speech.arrayBuffer());
		// wav rather than pcm on purpose: this also proves ffmpeg is usable.
		check(
			'proxy speech synthesis returns wav (also proves ffmpeg works)',
			speech.status === 200 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF',
			`${(bytes.byteLength / 1024).toFixed(0)} KB`
		);
	}
}

console.log('');
if (failures.length > 0) {
	console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`);
	process.exit(1);
}
console.log(`All smoke checks passed${skipped > 0 ? ` (${skipped} skipped)` : ''}.`);
