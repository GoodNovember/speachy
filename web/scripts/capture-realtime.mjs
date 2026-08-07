import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// Records a real realtime session against the Python reference so the event
// types are written from observed traffic rather than from reading the source.
//
//   node scripts/capture-realtime.mjs ws://127.0.0.1:8001

const BASE = process.argv[2] ?? 'ws://127.0.0.1:8001';
const MODEL = 'Systran/faster-whisper-tiny';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'python-reference');
const AUDIO = join(HERE, '..', '..', 'audio.wav');

const TARGET_RATE = 16_000;
const CHUNK_MS = 100;

// Minimal WAV reader. The app uses the tested helpers in src/lib/audio/pcm.ts;
// this script stays standalone so it can run without a build step.
function readWav(buffer) {
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const ascii = (offset, length) =>
		String.fromCharCode(...new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
	let offset = 12;
	let sampleRate = 0;
	while (offset < buffer.length - 8) {
		const id = ascii(offset, 4);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
		if (id === 'data') {
			const samples = new Int16Array(size / 2);
			for (let i = 0; i < samples.length; i += 1) {
				samples[i] = view.getInt16(offset + 8 + i * 2, true);
			}
			return { samples, sampleRate };
		}
		offset += 8 + size + (size % 2);
	}
	throw new Error('No data chunk in WAV');
}

function resampleInt16(input, fromRate, toRate) {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const out = new Int16Array(Math.floor(input.length / ratio));
	for (let i = 0; i < out.length; i += 1) {
		const position = i * ratio;
		const left = Math.floor(position);
		const right = Math.min(left + 1, input.length - 1);
		const weight = position - left;
		out[i] = Math.round(input[left] * (1 - weight) + input[right] * weight);
	}
	return out;
}

const wav = readWav(await readFile(AUDIO));
const pcm = resampleInt16(wav.samples, wav.sampleRate, TARGET_RATE);
console.log(`Source ${wav.sampleRate} Hz -> ${TARGET_RATE} Hz, ${pcm.length} samples`);

const url = `${BASE}/v1/realtime?model=${encodeURIComponent(MODEL)}&intent=transcription`;
const socket = new WebSocket(url);

const events = [];
const sent = [];
const startedAt = Date.now();

const record = (direction, event) => {
	const entry = { atMs: Date.now() - startedAt, direction, event };
	(direction === 'server' ? events : sent).push(entry);
	if (direction === 'server') console.log(`  <- ${event.type}`);
};

const send = (event) => {
	record('client', event);
	socket.send(JSON.stringify(event));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamAudio() {
	const samplesPerChunk = (TARGET_RATE * CHUNK_MS) / 1000;
	for (let offset = 0; offset < pcm.length; offset += samplesPerChunk) {
		const slice = pcm.subarray(offset, offset + samplesPerChunk);
		const bytes = new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength);
		send({ type: 'input_audio_buffer.append', audio: Buffer.from(bytes).toString('base64') });
		await sleep(CHUNK_MS / 2);
	}
	// Padding of silence so server VAD sees the utterance end.
	const silence = Buffer.alloc(samplesPerChunk * 2);
	for (let i = 0; i < 8; i += 1) {
		send({ type: 'input_audio_buffer.append', audio: silence.toString('base64') });
		await sleep(CHUNK_MS / 2);
	}
	send({ type: 'input_audio_buffer.commit' });
}

const finished = new Promise((resolve) => {
	const timer = setTimeout(() => {
		console.log('  (timed out waiting for transcription)');
		resolve();
	}, 45_000);

	socket.on('open', () => console.log('connected'));

	socket.on('message', async (data) => {
		const event = JSON.parse(data.toString());
		record('server', event);

		if (event.type === 'session.created') {
			send({
				type: 'session.update',
				session: { input_audio_transcription: { model: MODEL, language: 'en' } }
			});
			void streamAudio();
		}

		if (
			event.type === 'conversation.item.input_audio_transcription.completed' ||
			event.type === 'conversation.item.input_audio_transcription.failed'
		) {
			clearTimeout(timer);
			await sleep(500);
			socket.close();
			resolve();
		}
	});

	socket.on('error', (error) => {
		console.error('socket error:', error.message);
		clearTimeout(timer);
		resolve();
	});
	socket.on('close', () => {
		clearTimeout(timer);
		resolve();
	});
});

await finished;

const serverTypes = [...new Set(events.map((e) => e.event.type))];
const clientTypes = [...new Set(sent.map((e) => e.event.type))];

// input_audio_buffer.append carries a base64 payload per 100ms; keeping every
// one would bloat the fixture without adding information.
const trimmed = sent.map((entry) =>
	entry.event.type === 'input_audio_buffer.append'
		? { ...entry, event: { ...entry.event, audio: `<${entry.event.audio.length} base64 chars>` } }
		: entry
);

await mkdir(OUT, { recursive: true });
await writeFile(
	join(OUT, 'realtime-session.json'),
	`${JSON.stringify(
		{
			url: url.replace(/^ws/, 'ws'),
			serverEventTypes: serverTypes,
			clientEventTypes: clientTypes,
			appendCount: sent.filter((e) => e.event.type === 'input_audio_buffer.append').length,
			sent: trimmed.filter((e) => e.event.type !== 'input_audio_buffer.append').slice(0, 10),
			received: events
		},
		null,
		2
	)}\n`,
	'utf8'
);

console.log(`\nserver event types: ${serverTypes.join(', ')}`);
console.log(`client event types: ${clientTypes.join(', ')}`);
console.log(`wrote ${events.length} server events to realtime-session.json`);
