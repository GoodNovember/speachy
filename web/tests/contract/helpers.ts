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

	let voice: string | undefined;
	if (speech !== undefined) {
		const voices = (await (await fetch(api('/v1/audio/voices'))).json()) as {
			voices: { name?: string; id?: string }[];
		};
		voice = voices.voices[0]?.name ?? voices.voices[0]?.id;
	}

	discovered = { transcription, speech, voice };
	return discovered;
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
