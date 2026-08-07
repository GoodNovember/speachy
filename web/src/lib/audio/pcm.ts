// Pure audio maths, kept separate from anything touching the Web Audio API so
// it can be tested without a browser or a microphone.

export const REALTIME_SAMPLE_RATE = 16_000;

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

// Float32 [-1, 1] to signed 16-bit. The asymmetric scale is deliberate: the
// negative range has one more step than the positive one.
export function floatToPcm16(input: Float32Array): Int16Array {
	const out = new Int16Array(input.length);
	for (let i = 0; i < input.length; i += 1) {
		const sample = clamp(input[i], -1, 1);
		out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
	}
	return out;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
	const out = new Float32Array(input.length);
	for (let i = 0; i < input.length; i += 1) {
		out[i] = input[i] < 0 ? input[i] / 0x8000 : input[i] / 0x7fff;
	}
	return out;
}

// Linear interpolation. Only used when the AudioContext refuses to run at the
// target rate; otherwise the browser resamples natively and better.
export function resampleLinear(
	input: Float32Array,
	fromRate: number,
	toRate: number
): Float32Array {
	if (fromRate === toRate) return new Float32Array(input);
	if (input.length === 0) return new Float32Array(0);

	const ratio = fromRate / toRate;
	const outLength = Math.floor(input.length / ratio);
	const out = new Float32Array(outLength);

	for (let i = 0; i < outLength; i += 1) {
		const position = i * ratio;
		const left = Math.floor(position);
		const right = Math.min(left + 1, input.length - 1);
		const weight = position - left;
		out[i] = input[left] * (1 - weight) + input[right] * weight;
	}
	return out;
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export function rms(input: Float32Array): number {
	if (input.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
	return Math.sqrt(sum / input.length);
}

// A real WAV header, unlike the reference server's streaming output which
// leaves the RIFF size as 0xFFFFFFFF because it does not know the length yet.
export function encodeWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
	const bytesPerSample = 2;
	const channels = 1;
	const dataBytes = pcm.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	const writeAscii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true); // PCM header size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
	view.setUint16(32, channels * bytesPerSample, true); // block align
	view.setUint16(34, 8 * bytesPerSample, true);
	writeAscii(36, 'data');
	view.setUint32(40, dataBytes, true);

	for (let i = 0; i < pcm.length; i += 1) {
		view.setInt16(44 + i * bytesPerSample, pcm[i], true);
	}
	return buffer;
}

export function pcm16ToBase64(pcm: Int16Array): string {
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let binary = '';
	// Chunked to avoid blowing the argument limit on long buffers.
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}
