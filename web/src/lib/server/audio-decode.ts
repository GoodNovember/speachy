import { spawn } from 'node:child_process';
import { resampleAudioData, resolveFfmpegPath } from './audio.ts';
import type { Audio } from './executors/types.ts';

const TARGET_SAMPLE_RATE = 16_000;

export class AudioDecodeError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 415
	) {
		super(message);
		this.name = 'AudioDecodeError';
	}
}

function audioName(fileName: string | undefined): string | undefined {
	if (fileName === undefined || fileName.length === 0) return undefined;
	const baseName = fileName.split(/[\\/]/).at(-1)!;
	const extension = baseName.lastIndexOf('.');
	return extension > 0 ? baseName.slice(0, extension) : baseName;
}

function malformed(
	message = 'Failed to decode audio. The provided file type is not supported.'
): never {
	throw new AudioDecodeError(message, 415);
}

function decodeRawPcm16(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength === 0) {
		throw new AudioDecodeError('Failed to decode audio. The provided file is likely empty.', 400);
	}
	if (bytes.byteLength % 2 !== 0) malformed();
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Float32Array(bytes.byteLength / 2);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = view.getInt16(index * 2, true) / 32_768;
	}
	return samples;
}

function decodePcmWav(bytes: Uint8Array): { data: Float32Array; sampleRate: number } {
	if (bytes.byteLength < 12) malformed();
	const ascii = (start: number, end: number): string =>
		Buffer.from(bytes.subarray(start, end)).toString('ascii');
	if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') malformed();

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let formatOffset: number | undefined;
	let formatLength = 0;
	let dataOffset: number | undefined;
	let dataLength = 0;
	for (let offset = 12; offset + 8 <= bytes.byteLength;) {
		const kind = ascii(offset, offset + 4);
		const length = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (body + length > bytes.byteLength) malformed();
		if (kind === 'fmt ') {
			formatOffset = body;
			formatLength = length;
		}
		if (kind === 'data') {
			dataOffset = body;
			dataLength = length;
		}
		offset = body + length + (length % 2);
	}
	if (formatOffset === undefined || dataOffset === undefined || formatLength < 16) malformed();
	if (dataLength === 0) {
		throw new AudioDecodeError('Failed to decode audio. The provided file is likely empty.', 400);
	}

	const format = view.getUint16(formatOffset, true);
	const channels = view.getUint16(formatOffset + 2, true);
	const sampleRate = view.getUint32(formatOffset + 4, true);
	const blockAlign = view.getUint16(formatOffset + 12, true);
	const bitsPerSample = view.getUint16(formatOffset + 14, true);
	const bytesPerSample = bitsPerSample / 8;
	if (
		channels === 0 ||
		sampleRate === 0 ||
		!Number.isInteger(bytesPerSample) ||
		blockAlign !== channels * bytesPerSample ||
		dataLength % blockAlign !== 0 ||
		!((format === 1 && bitsPerSample === 16) || (format === 3 && bitsPerSample === 32))
	) {
		malformed();
	}

	const frames = dataLength / blockAlign;
	const data = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame += 1) {
		let mixed = 0;
		for (let channel = 0; channel < channels; channel += 1) {
			const offset = dataOffset + frame * blockAlign + channel * bytesPerSample;
			mixed += format === 1 ? view.getInt16(offset, true) / 32_768 : view.getFloat32(offset, true);
		}
		const sample = mixed / channels;
		if (!Number.isFinite(sample)) malformed();
		data[frame] = sample;
	}
	return { data, sampleRate };
}

async function decodeWithFfmpeg(
	bytes: Uint8Array,
	signal: AbortSignal,
	ffmpegPath?: string
): Promise<Float32Array> {
	if (bytes.byteLength === 0) {
		throw new AudioDecodeError('Failed to decode audio. The provided file is likely empty.', 400);
	}
	if (signal.aborted) throw signal.reason;
	const child = spawn(
		resolveFfmpegPath(ffmpegPath),
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-i',
			'pipe:0',
			'-f',
			'f32le',
			'-ar',
			String(TARGET_SAMPLE_RATE),
			'-ac',
			'1',
			'pipe:1'
		],
		{ stdio: ['pipe', 'pipe', 'pipe'] }
	);
	const abort = (): void => {
		child.kill();
	};
	signal.addEventListener('abort', abort, { once: true });
	child.stdin.on('error', () => {
		// Invalid input may close ffmpeg before stdin is fully written. The
		// process status and stderr below carry the useful error.
	});
	child.stdin.end(bytes);

	const collect = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
		const chunks: Buffer[] = [];
		for await (const chunk of stream) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks);
	};
	try {
		const [stdout, , result] = await Promise.all([
			collect(child.stdout),
			collect(child.stderr),
			new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }));
			})
		]);
		if (signal.aborted) throw signal.reason;
		if (result.code !== 0 || stdout.byteLength === 0 || stdout.byteLength % 4 !== 0) {
			malformed();
		}
		const view = new DataView(stdout.buffer, stdout.byteOffset, stdout.byteLength);
		const data = new Float32Array(stdout.byteLength / 4);
		for (let index = 0; index < data.length; index += 1) {
			const sample = view.getFloat32(index * 4, true);
			if (!Number.isFinite(sample)) malformed();
			data[index] = sample;
		}
		return data;
	} finally {
		signal.removeEventListener('abort', abort);
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}

export type DecodeAudioUploadOptions = {
	signal?: AbortSignal;
	targetSampleRate?: number;
	ffmpegPath?: string;
};

export async function decodeAudioUpload(
	file: Blob,
	options: DecodeAudioUploadOptions = {}
): Promise<Audio> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const signal = options.signal ?? new AbortController().signal;
	const targetSampleRate = options.targetSampleRate ?? TARGET_SAMPLE_RATE;
	if (!Number.isInteger(targetSampleRate) || targetSampleRate <= 0) {
		throw new RangeError(`Invalid target sample rate: ${targetSampleRate}`);
	}

	let data: Float32Array;
	let sampleRate: number;
	if (file.type === 'audio/pcm' || file.type === 'audio/raw') {
		data = decodeRawPcm16(bytes);
		sampleRate = TARGET_SAMPLE_RATE;
	} else if (
		file.type === 'audio/wav' ||
		file.type === 'audio/x-wav' ||
		file.type === 'audio/wave' ||
		(Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
			Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WAVE')
	) {
		({ data, sampleRate } = decodePcmWav(bytes));
	} else {
		data = await decodeWithFfmpeg(bytes, signal, options.ffmpegPath);
		sampleRate = TARGET_SAMPLE_RATE;
	}

	if (sampleRate !== targetSampleRate) {
		data = resampleAudioData(data, sampleRate, targetSampleRate);
	}
	return {
		data,
		sampleRate: targetSampleRate,
		name: audioName(
			typeof (file as Blob & { name?: unknown }).name === 'string'
				? (file as Blob & { name: string }).name
				: undefined
		)
	};
}
