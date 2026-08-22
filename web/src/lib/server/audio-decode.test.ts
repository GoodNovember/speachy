import { describe, expect, it } from 'vitest';
import { encodeWav, float32ToPcm16Bytes } from './audio.ts';
import { AudioDecodeError, decodeAudioUpload } from './audio-decode.ts';

function namedBlob(parts: BlobPart[], type: string, name: string): Blob {
	return Object.assign(new Blob(parts, { type }), { name });
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

describe('decodeAudioUpload', () => {
	it('decodes PCM WAV, resamples to 16 kHz, and preserves the filename stem', async () => {
		const wav = encodeWav({ data: new Float32Array([0, 0.5, -0.5, 0.25]), sampleRate: 8_000 });
		const decoded = await decodeAudioUpload(
			namedBlob([asArrayBuffer(wav)], 'audio/wav', 'folder/clip.wav')
		);

		expect(decoded.sampleRate).toBe(16_000);
		expect(decoded.name).toBe('clip');
		expect(decoded.data.length).toBe(8);
		expect(decoded.data.every(Number.isFinite)).toBe(true);
	});

	it('decodes headerless PCM16 using the API contract sample rate', async () => {
		const pcm = float32ToPcm16Bytes(new Float32Array([-1, 0, 0.5]));
		const decoded = await decodeAudioUpload(
			namedBlob([asArrayBuffer(pcm)], 'audio/pcm', 'raw.pcm')
		);

		expect(decoded.sampleRate).toBe(16_000);
		expect(decoded.data).toEqual(new Float32Array([-32767 / 32768, 0, 16383 / 32768]));
	});

	it('distinguishes empty audio from unsupported WAV data', async () => {
		await expect(decodeAudioUpload(new Blob([], { type: 'audio/pcm' }))).rejects.toMatchObject({
			status: 400
		});
		await expect(
			decodeAudioUpload(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }))
		).rejects.toBeInstanceOf(AudioDecodeError);
		await expect(
			decodeAudioUpload(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }))
		).rejects.toMatchObject({ status: 415 });
	});
});
