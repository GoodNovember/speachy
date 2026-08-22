import { describe, expect, it } from 'vitest';
import {
	AudioBuffer,
	encodeAudio,
	encodeWav,
	float32ToPcm16Bytes,
	pcm16BytesToFloat32,
	resampleAudioBytes,
	resampleAudioData,
	resolveFfmpegPath,
	streamAudioAsFormattedBytes
} from './audio.ts';

function sine(sampleRate = 16_000, seconds = 0.05): AudioBuffer {
	return new AudioBuffer(
		Float32Array.from(
			{ length: sampleRate * seconds },
			(_unused, index) => Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 0.25
		),
		sampleRate
	);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

describe('PCM conversion and resampling', () => {
	it('matches Python truncation and little-endian encoding', () => {
		const bytes = float32ToPcm16Bytes(new Float32Array([0, 1, -1, 0.5, -0.5]));
		const view = new DataView(bytes.buffer);
		expect([...Array(5).keys()].map((index) => view.getInt16(index * 2, true))).toEqual([
			0, 32767, -32767, 16383, -16383
		]);
	});

	it('decodes signed little-endian PCM16 to floats', () => {
		const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0]);
		expect([...pcm16BytesToFloat32(bytes)]).toEqual([0.5, -0.5]);
	});

	it('resamples float data and PCM bytes in both directions', () => {
		const data = Float32Array.from({ length: 480 }, (_unused, index) => index / 480);
		expect(resampleAudioData(data, 48_000, 16_000)).toHaveLength(160);
		expect(resampleAudioData(data.subarray(0, 160), 16_000, 48_000)).toHaveLength(480);
		const pcm = float32ToPcm16Bytes(data);
		expect(resampleAudioBytes(pcm, 48_000, 16_000)).toHaveLength(320);
	});
});

describe('AudioBuffer', () => {
	it('reports size and duration and concatenates matching audio', () => {
		const first = new AudioBuffer(new Float32Array([0, 0.5]), 2);
		first.extend(new Float32Array([-0.5]));
		expect(first.duration).toBe(1.5);
		expect(first.sizeInBytes).toBe(12);
		expect([
			...AudioBuffer.concatenate([first, new AudioBuffer(new Float32Array([1]), 2)]).data
		]).toEqual([0, 0.5, -0.5, 1]);
	});

	it('rejects concatenation across sample rates', () => {
		expect(() =>
			AudioBuffer.concatenate([
				new AudioBuffer(new Float32Array(1), 16_000),
				new AudioBuffer(new Float32Array(1), 24_000)
			])
		).toThrow('same sample rate');
	});
});

describe('WAV encoding', () => {
	it('writes a sized mono PCM header for a complete buffer', () => {
		const wav = encodeWav(sine());
		const view = new DataView(wav.buffer);
		expect(Buffer.from(wav.subarray(0, 4)).toString('ascii')).toBe('RIFF');
		expect(Buffer.from(wav.subarray(8, 12)).toString('ascii')).toBe('WAVE');
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint16(34, true)).toBe(16);
	});

	it('uses unknown sizes for an incremental WAV stream', async () => {
		async function* source() {
			yield sine();
		}
		const wav = await collect(streamAudioAsFormattedBytes(source(), 'wav'));
		const view = new DataView(wav.buffer);
		expect(view.getUint32(4, true)).toBe(0xffffffff);
		expect(view.getUint32(40, true)).toBe(0xffffffff);
	});
});

describe('formatted audio streams', () => {
	it('returns raw PCM without a container', async () => {
		const audio = sine();
		expect(await encodeAudio(audio, 'pcm')).toEqual(audio.asBytes());
	});

	it.each([
		[
			'mp3',
			(bytes: Uint8Array) =>
				Buffer.from(bytes.subarray(0, 3)).toString('ascii') === 'ID3' || bytes[0] === 0xff
		],
		['flac', (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'fLaC'],
		['opus', (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'OggS'],
		['aac', (bytes: Uint8Array) => bytes[0] === 0xff && (bytes[1]! & 0xf0) === 0xf0]
	] as const)('encodes %s through ffmpeg', async (format, hasHeader) => {
		const bytes = await encodeAudio(sine(), format);
		expect(bytes.byteLength).toBeGreaterThan(0);
		expect(hasHeader(bytes)).toBe(true);
	});

	it('resamples streamed PCM to the requested rate', async () => {
		async function* source() {
			yield sine(16_000, 0.1);
		}
		const bytes = await collect(
			streamAudioAsFormattedBytes(source(), 'pcm', { sampleRate: 8_000 })
		);
		expect(bytes.byteLength).toBe(1_600);
	});

	it('rejects inconsistent source sample rates', async () => {
		async function* source() {
			yield sine(16_000);
			yield sine(24_000);
		}
		await expect(collect(streamAudioAsFormattedBytes(source(), 'pcm'))).rejects.toThrow(
			'Inconsistent sample rate'
		);
	});

	it('honors a pre-aborted signal before starting ffmpeg', async () => {
		const controller = new AbortController();
		controller.abort(new Error('cancelled'));
		async function* source() {
			yield sine();
		}
		await expect(
			collect(streamAudioAsFormattedBytes(source(), 'mp3', { signal: controller.signal }))
		).rejects.toThrow('cancelled');
	});

	it('terminates an active ffmpeg stream when aborted', async () => {
		const controller = new AbortController();
		async function* source() {
			yield sine();
			await new Promise<void>((_resolve, reject) => {
				controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
					once: true
				});
			});
		}
		const encoded = collect(
			streamAudioAsFormattedBytes(source(), 'mp3', { signal: controller.signal })
		);
		setTimeout(() => controller.abort(new Error('active cancellation')), 20);
		await expect(encoded).rejects.toThrow('active cancellation');
	});

	it('surfaces a missing ffmpeg executable without crashing the process', async () => {
		async function* source() {
			yield sine();
		}
		await expect(
			collect(
				streamAudioAsFormattedBytes(source(), 'mp3', {
					ffmpegPath: 'speachy-definitely-missing-ffmpeg'
				})
			)
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

describe('ffmpeg resolution', () => {
	it('uses an explicit path on every platform', () => {
		expect(
			resolveFfmpegPath('/opt/speachy/bin/ffmpeg', {
				platform: 'linux',
				environment: { FFMPEG_PATH: '/usr/bin/ffmpeg' }
			})
		).toBe('/opt/speachy/bin/ffmpeg');
	});

	it.each(['linux', 'darwin'] as const)('uses FFMPEG_PATH on %s', (platform) => {
		expect(
			resolveFfmpegPath(undefined, {
				platform,
				environment: { FFMPEG_PATH: '/custom/ffmpeg' }
			})
		).toBe('/custom/ffmpeg');
	});

	it.each(['linux', 'darwin'] as const)('falls back to PATH lookup on %s', (platform) => {
		expect(resolveFfmpegPath(undefined, { platform, environment: {} })).toBe('ffmpeg');
	});

	it('uses the WinGet link on Windows when present', () => {
		const resolved = resolveFfmpegPath(undefined, {
			platform: 'win32',
			environment: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
			pathExists: () => true
		});
		expect(resolved).toBe('C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe');
	});

	it('falls back to PATH lookup when the WinGet link is absent', () => {
		expect(
			resolveFfmpegPath(undefined, {
				platform: 'win32',
				environment: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
				pathExists: () => false
			})
		).toBe('ffmpeg');
	});
});
