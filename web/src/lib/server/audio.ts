import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Audio } from './executors/types.ts';

export type AudioFormat = 'aac' | 'pcm' | 'opus' | 'mp3' | 'flac' | 'wav';

function validateSampleRate(sampleRate: number): void {
	if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
		throw new RangeError(`Invalid sample rate: ${sampleRate}`);
	}
}

export function resampleAudioData(
	data: Float32Array,
	sampleRate: number,
	targetSampleRate: number
): Float32Array {
	validateSampleRate(sampleRate);
	validateSampleRate(targetSampleRate);
	if (data.length === 0) return new Float32Array();
	const targetLength = Math.trunc(data.length * (targetSampleRate / sampleRate));
	if (targetLength === 0) return new Float32Array();

	const output = new Float32Array(targetLength);
	for (let index = 0; index < targetLength; index += 1) {
		// Matches numpy.linspace(0, len(data), targetLength), including its end point.
		const position = targetLength === 1 ? 0 : (index * data.length) / (targetLength - 1);
		const left = Math.min(Math.floor(position), data.length - 1);
		const right = Math.min(left + 1, data.length - 1);
		const weight = Math.min(position - left, 1);
		output[index] = data[left]! * (1 - weight) + data[right]! * weight;
	}
	return output;
}

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength % 2 !== 0)
		throw new Error('PCM16 data must contain a whole number of samples');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const output = new Float32Array(bytes.byteLength / 2);
	for (let index = 0; index < output.length; index += 1) {
		output[index] = view.getInt16(index * 2, true) / 32768;
	}
	return output;
}

export function float32ToPcm16Bytes(data: Float32Array): Uint8Array {
	const bytes = new Uint8Array(data.length * 2);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < data.length; index += 1) {
		// Python multiplies by 32767 and astype(int16), which truncates rather than rounds.
		view.setInt16(index * 2, Math.trunc(data[index]! * 32767), true);
	}
	return bytes;
}

export function resampleAudioBytes(
	bytes: Uint8Array,
	sampleRate: number,
	targetSampleRate: number
): Uint8Array {
	validateSampleRate(sampleRate);
	validateSampleRate(targetSampleRate);
	if (bytes.byteLength % 2 !== 0)
		throw new Error('PCM16 data must contain a whole number of samples');
	const inputView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const inputLength = bytes.byteLength / 2;
	if (inputLength === 0) return new Uint8Array();
	const targetLength = Math.trunc((inputLength / sampleRate) * targetSampleRate);
	const output = new Uint8Array(targetLength * 2);
	const outputView = new DataView(output.buffer);

	for (let index = 0; index < targetLength; index += 1) {
		// Matches numpy.linspace(..., endpoint=False) in resample_audio_bytes.
		const position = (index * inputLength) / targetLength;
		const left = Math.min(Math.floor(position), inputLength - 1);
		const right = Math.min(left + 1, inputLength - 1);
		const weight = position - left;
		const sample =
			inputView.getInt16(left * 2, true) * (1 - weight) +
			inputView.getInt16(right * 2, true) * weight;
		outputView.setInt16(index * 2, Math.trunc(sample), true);
	}
	return output;
}

export class AudioBuffer implements Audio {
	constructor(
		public data: Float32Array,
		public sampleRate: number,
		public name?: string
	) {
		validateSampleRate(sampleRate);
	}

	get duration(): number {
		return this.data.length / this.sampleRate;
	}

	get sizeInBits(): number {
		return this.data.byteLength * 8;
	}

	get sizeInBytes(): number {
		return this.data.byteLength;
	}

	get sizeInKb(): number {
		return this.sizeInBytes / 1024;
	}

	get sizeInMb(): number {
		return this.sizeInBytes / (1024 * 1024);
	}

	extend(data: Float32Array): void {
		const combined = new Float32Array(this.data.length + data.length);
		combined.set(this.data);
		combined.set(data, this.data.length);
		this.data = combined;
	}

	asBytes(): Uint8Array {
		return float32ToPcm16Bytes(this.data);
	}

	toBase64(): string {
		return Buffer.from(this.asBytes()).toString('base64');
	}

	resample(targetSampleRate: number): this {
		if (this.sampleRate === targetSampleRate) return this;
		this.data = resampleAudioData(this.data, this.sampleRate, targetSampleRate);
		this.sampleRate = targetSampleRate;
		return this;
	}

	static concatenate(audios: Audio[]): AudioBuffer {
		if (audios.length === 0) throw new Error('No audio segments to concatenate');
		const sampleRate = audios[0]!.sampleRate;
		if (audios.some((audio) => audio.sampleRate !== sampleRate)) {
			throw new Error('All audio segments must have the same sample rate to concatenate');
		}
		const length = audios.reduce((total, audio) => total + audio.data.length, 0);
		const data = new Float32Array(length);
		let offset = 0;
		for (const audio of audios) {
			data.set(audio.data, offset);
			offset += audio.data.length;
		}
		return new AudioBuffer(data, sampleRate);
	}
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let index = 0; index < text.length; index += 1) {
		view.setUint8(offset + index, text.charCodeAt(index));
	}
}

export function wavHeader(sampleRate: number, dataLength: number | undefined): Uint8Array {
	validateSampleRate(sampleRate);
	const header = new Uint8Array(44);
	const view = new DataView(header.buffer);
	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, dataLength === undefined ? 0xffffffff : 36 + dataLength, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataLength ?? 0xffffffff, true);
	return header;
}

export function encodeWav(audio: Audio): Uint8Array {
	const pcm = float32ToPcm16Bytes(audio.data);
	const output = new Uint8Array(44 + pcm.byteLength);
	output.set(wavHeader(audio.sampleRate, pcm.byteLength));
	output.set(pcm, 44);
	return output;
}

function formattedAudio(audio: Audio, targetSampleRate: number): Uint8Array {
	return audio.sampleRate === targetSampleRate
		? float32ToPcm16Bytes(audio.data)
		: float32ToPcm16Bytes(resampleAudioData(audio.data, audio.sampleRate, targetSampleRate));
}

const FFMPEG_FORMAT_ARGS: Record<Exclude<AudioFormat, 'pcm' | 'wav'>, string[]> = {
	mp3: ['-f', 'mp3', '-codec:a', 'libmp3lame'],
	flac: ['-f', 'flac'],
	opus: ['-f', 'opus', '-codec:a', 'libopus'],
	aac: ['-f', 'adts', '-codec:a', 'aac']
};

async function writeChunk(stream: NodeJS.WritableStream, chunk: Uint8Array): Promise<void> {
	if (stream.write(chunk)) return;
	await once(stream, 'drain');
}

export type AudioStreamOptions = {
	sampleRate?: number;
	signal?: AbortSignal;
	ffmpegPath?: string;
};

export function resolveFfmpegPath(explicitPath?: string): string {
	if (explicitPath !== undefined) return explicitPath;
	if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
		const wingetLink = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
		if (existsSync(wingetLink)) return wingetLink;
	}
	return 'ffmpeg';
}

export async function* streamAudioAsFormattedBytes(
	audios: AsyncIterable<Audio>,
	format: AudioFormat,
	options: AudioStreamOptions = {}
): AsyncGenerator<Uint8Array> {
	const iterator = audios[Symbol.asyncIterator]();
	if (options.signal?.aborted) throw options.signal.reason;
	const first = await iterator.next();
	if (first.done) return;

	const sourceSampleRate = first.value.sampleRate;
	const targetSampleRate = options.sampleRate ?? sourceSampleRate;
	validateSampleRate(sourceSampleRate);
	validateSampleRate(targetSampleRate);

	if (format === 'pcm' || format === 'wav') {
		if (format === 'wav') yield wavHeader(targetSampleRate, undefined);
		let next: IteratorResult<Audio> = first;
		while (!next.done) {
			if (options.signal?.aborted) throw options.signal.reason;
			if (next.value.sampleRate !== sourceSampleRate) {
				throw new Error(
					`Inconsistent sample rate: expected ${sourceSampleRate}, got ${next.value.sampleRate}`
				);
			}
			yield formattedAudio(next.value, targetSampleRate);
			next = await iterator.next();
		}
		return;
	}

	const process = spawn(
		resolveFfmpegPath(options.ffmpegPath),
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			's16le',
			'-ar',
			String(sourceSampleRate),
			'-ac',
			'1',
			'-i',
			'pipe:0',
			'-ar',
			String(targetSampleRate),
			...FFMPEG_FORMAT_ARGS[format],
			'pipe:1'
		],
		{ stdio: ['pipe', 'pipe', 'pipe'] }
	);

	let writeError: unknown;
	let exited = false;
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			process.once('error', reject);
			process.once('close', (code, signal) => {
				exited = true;
				resolve({ code, signal });
			});
		}
	);
	const stderr = (async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stderr) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString('utf8');
	})();
	const abort = (): void => {
		process.kill();
	};
	options.signal?.addEventListener('abort', abort, { once: true });

	const writer = (async () => {
		try {
			let next: IteratorResult<Audio> = first;
			while (!next.done) {
				if (options.signal?.aborted) throw options.signal.reason;
				if (next.value.sampleRate !== sourceSampleRate) {
					throw new Error(
						`Inconsistent sample rate: expected ${sourceSampleRate}, got ${next.value.sampleRate}`
					);
				}
				await writeChunk(process.stdin, float32ToPcm16Bytes(next.value.data));
				next = await iterator.next();
			}
			process.stdin.end();
		} catch (error) {
			writeError = error;
			process.stdin.destroy();
			process.kill();
		}
	})();

	try {
		for await (const chunk of process.stdout) yield new Uint8Array(Buffer.from(chunk));
		await writer;
		const result = await exit;
		const errorOutput = await stderr;
		if (options.signal?.aborted) throw options.signal.reason;
		if (writeError !== undefined) throw writeError;
		if (result.code !== 0) {
			throw new Error(
				`ffmpeg failed with return code ${result.code ?? `signal ${result.signal}`}: ${errorOutput}`
			);
		}
	} finally {
		options.signal?.removeEventListener('abort', abort);
		if (!exited) process.kill();
		await iterator.return?.();
	}
}

export async function encodeAudio(
	audio: Audio,
	format: AudioFormat,
	options: AudioStreamOptions = {}
): Promise<Uint8Array> {
	if (format === 'pcm') return formattedAudio(audio, options.sampleRate ?? audio.sampleRate);
	if (format === 'wav') {
		const sampleRate = options.sampleRate ?? audio.sampleRate;
		return encodeWav(
			sampleRate === audio.sampleRate
				? audio
				: { data: resampleAudioData(audio.data, audio.sampleRate, sampleRate), sampleRate }
		);
	}

	const chunks: Uint8Array[] = [];
	async function* one(): AsyncGenerator<Audio> {
		yield audio;
	}
	for await (const chunk of streamAudioAsFormattedBytes(one(), format, options)) chunks.push(chunk);
	const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}
