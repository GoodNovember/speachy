import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

// The contract suite is the port's specification. It runs against whichever
// server SPEACHY_BASE_URL points at: the Python reference today, our own
// SvelteKit server once Phase 2 implements the endpoints. Both must pass the
// same tests, which is the whole point.
//
//   npm run test:contract                      # reference on 8001
//   SPEACHY_BASE_URL=http://127.0.0.1:8000 npm run test:contract

export const BASE_URL = process.env.SPEACHY_BASE_URL ?? 'http://127.0.0.1:8001';
export const API_KEY = process.env.SPEACHY_API_KEY ?? 'does-not-matter';

export const openai = new OpenAI({
	baseURL: `${BASE_URL}/v1`,
	apiKey: API_KEY,
	maxRetries: 0
});

export async function serverIsUp(): Promise<boolean> {
	try {
		const response = await fetch(new URL('/health', BASE_URL), {
			signal: AbortSignal.timeout(3000)
		});
		return response.ok;
	} catch {
		return false;
	}
}

export const audioPath = fileURLToPath(new URL('../../../audio.wav', import.meta.url));

// A plain ArrayBuffer, not a Buffer or a view over one. TypeScript requires
// BlobPart views to be backed by a real ArrayBuffer, and Node's Buffer is
// backed by ArrayBufferLike, so `new Blob([buffer])` will not typecheck.
let cachedAudio: ArrayBuffer | undefined;
export async function audioBytes(): Promise<ArrayBuffer> {
	if (cachedAudio === undefined) {
		const bytes = new Uint8Array(await readFile(audioPath));
		const copy = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(copy).set(bytes);
		cachedAudio = copy;
	}
	return cachedAudio;
}

export function api(path: string): URL {
	return new URL(path, BASE_URL);
}

// Raw request helper for the cases the OpenAI SDK cannot express, such as the
// bracketed timestamp_granularities[] field or asserting a content type.
export async function postForm(
	path: string,
	fields: Record<string, string | Blob>
): Promise<Response> {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return fetch(api(path), { method: 'POST', body: form });
}

export type DiscoveredModels = {
	transcription?: string;
	speech?: string;
	voice?: string;
	speakerEmbedding?: string;
	diarization?: string;
};

let discovered: DiscoveredModels | undefined;

// The pytest suite hardcodes Systran/faster-whisper-tiny.en and pulls it via a
// fixture. Discovering instead keeps the suite runnable against whatever is
// already downloaded, and avoids a multi-gigabyte surprise on a fresh machine.
export async function models(): Promise<DiscoveredModels> {
	if (discovered !== undefined) return discovered;

	const listed = (await (await fetch(api('/v1/models'))).json()) as {
		data: { id: string; task?: string }[];
	};
	const transcription = listed.data.find((m) => m.task === 'automatic-speech-recognition')?.id;
	const speech = listed.data.find((m) => m.task === 'text-to-speech')?.id;
	const speakerEmbedding = listed.data.find((m) => m.task === 'speaker-embedding')?.id;
	const diarization = listed.data.find((m) => m.task === 'speaker-diarization')?.id;

	let voice: string | undefined;
	if (speech !== undefined) {
		const voices = (await (await fetch(api('/v1/audio/voices'))).json()) as {
			voices: { name?: string; id?: string }[];
		};
		voice = voices.voices[0]?.name ?? voices.voices[0]?.id;
	}

	discovered = { transcription, speech, voice, speakerEmbedding, diarization };
	return discovered;
}

export function cosineSimilarity(left: number[], right: number[]): number {
	if (left.length !== right.length || left.length === 0) {
		throw new Error('Embedding vectors must have the same non-zero length');
	}
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index]! * right[index]!;
		leftMagnitude += left[index]! ** 2;
		rightMagnitude += right[index]! ** 2;
	}
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function encodePcm16Wav(payload: Uint8Array, sampleRate: number): ArrayBuffer {
	const blockAlign = 2;
	const output = new ArrayBuffer(44 + payload.byteLength);
	const outputBytes = new Uint8Array(output);
	const outputView = new DataView(output);
	const writeAscii = (at: number, value: string) => {
		for (let index = 0; index < value.length; index += 1) {
			outputView.setUint8(at + index, value.charCodeAt(index));
		}
	};
	writeAscii(0, 'RIFF');
	outputView.setUint32(4, output.byteLength - 8, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	outputView.setUint32(16, 16, true);
	outputView.setUint16(20, 1, true);
	outputView.setUint16(22, 1, true);
	outputView.setUint32(24, sampleRate, true);
	outputView.setUint32(28, sampleRate * blockAlign, true);
	outputView.setUint16(32, blockAlign, true);
	outputView.setUint16(34, 16, true);
	writeAscii(36, 'data');
	outputView.setUint32(40, payload.byteLength, true);
	outputBytes.set(payload, 44);
	return output;
}

export function sinePcm16Wav(
	frequency: number,
	durationSeconds: number,
	sampleRate = 16_000
): ArrayBuffer {
	const sampleCount = Math.round(durationSeconds * sampleRate);
	const payload = new Uint8Array(sampleCount * 2);
	const view = new DataView(payload.buffer);
	for (let index = 0; index < sampleCount; index += 1) {
		const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
		view.setInt16(index * 2, Math.trunc(sample * 32_767), true);
	}
	return encodePcm16Wav(payload, sampleRate);
}

// The checked-in speech fixture is deliberately short. Repeat its mono PCM16
// payload into a conventional WAV so diarization gets enough speech to produce
// stable turns without introducing another binary fixture.
export function repeatPcm16Wav(source: ArrayBuffer, minimumSeconds: number): ArrayBuffer {
	const bytes = new Uint8Array(source);
	const view = new DataView(source);
	const ascii = (offset: number, length: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + length));
	if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') {
		throw new Error('Audio fixture is not a RIFF/WAVE file');
	}

	let offset = 12;
	let sampleRate: number | undefined;
	let blockAlign: number | undefined;
	let data: Uint8Array | undefined;
	while (offset + 8 <= bytes.byteLength) {
		const id = ascii(offset, 4);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (body + size > bytes.byteLength) break;
		if (id === 'fmt ') {
			if (
				size < 16 ||
				view.getUint16(body, true) !== 1 ||
				view.getUint16(body + 2, true) !== 1 ||
				view.getUint16(body + 14, true) !== 16
			) {
				throw new Error('Audio fixture must be mono 16-bit PCM');
			}
			sampleRate = view.getUint32(body + 4, true);
			blockAlign = view.getUint16(body + 12, true);
		} else if (id === 'data') {
			data = bytes.slice(body, body + size);
		}
		offset = body + size + (size % 2);
	}
	if (
		sampleRate === undefined ||
		blockAlign === undefined ||
		data === undefined ||
		data.length === 0
	) {
		throw new Error('Audio fixture is missing fmt or data');
	}

	const seconds = data.byteLength / (sampleRate * blockAlign);
	const repetitions = Math.max(1, Math.ceil(minimumSeconds / seconds));
	const payload = new Uint8Array(data.byteLength * repetitions);
	for (let index = 0; index < repetitions; index += 1) {
		payload.set(data, index * data.byteLength);
	}

	return encodePcm16Wav(payload, sampleRate);
}

// Minimal SRT structural check, standing in for the python `srt` package.
export function parseSrt(text: string): { index: number; start: string; end: string }[] {
	const blocks = text.trim().split(/\r?\n\r?\n/);
	return blocks.map((block) => {
		const lines = block.split(/\r?\n/);
		const index = Number(lines[0]);
		if (!Number.isInteger(index)) throw new Error(`Bad SRT index: ${lines[0]}`);
		const match = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(lines[1] ?? '');
		if (match === null) throw new Error(`Bad SRT timing line: ${lines[1]}`);
		return { index, start: match[1], end: match[2] };
	});
}

// Minimal WebVTT structural check, standing in for the python `webvtt` package.
export function parseVtt(text: string): { start: string; end: string }[] {
	if (!text.startsWith('WEBVTT')) throw new Error('Missing WEBVTT header');
	const cues: { start: string; end: string }[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/.exec(line);
		if (match !== null) cues.push({ start: match[1], end: match[2] });
	}
	if (cues.length === 0) throw new Error('No cues found');
	return cues;
}

export async function collectSse(response: Response): Promise<string[]> {
	const text = await response.text();
	return text
		.split(/\r?\n\r?\n/)
		.map((block) =>
			block
				.split(/\r?\n/)
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trimStart())
				.join('\n')
		)
		.filter((data) => data !== '');
}
