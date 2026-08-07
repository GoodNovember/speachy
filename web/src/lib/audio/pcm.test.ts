import { describe, expect, it } from 'vitest';
import {
	concatFloat32,
	encodeWav,
	floatToPcm16,
	pcm16ToBase64,
	pcm16ToFloat,
	resampleLinear,
	rms
} from './pcm.ts';

describe('floatToPcm16', () => {
	it('maps the full scale endpoints', () => {
		const out = floatToPcm16(new Float32Array([0, 1, -1]));
		expect([...out]).toEqual([0, 32767, -32768]);
	});

	it('clamps values beyond the valid range', () => {
		const out = floatToPcm16(new Float32Array([2, -2]));
		expect([...out]).toEqual([32767, -32768]);
	});

	it('never wraps around, which would sound like a click', () => {
		const out = floatToPcm16(new Float32Array([0.9999999, -0.9999999]));
		expect(out[0]).toBeLessThanOrEqual(32767);
		expect(out[1]).toBeGreaterThanOrEqual(-32768);
	});
});

describe('pcm16ToFloat', () => {
	it('round-trips within one quantisation step', () => {
		const original = new Float32Array([0, 0.5, -0.5, 0.25, -0.75, 1, -1]);
		const restored = pcm16ToFloat(floatToPcm16(original));
		for (let i = 0; i < original.length; i += 1) {
			expect(restored[i]).toBeCloseTo(original[i], 4);
		}
	});
});

describe('resampleLinear', () => {
	it('returns a copy when the rates match', () => {
		const input = new Float32Array([1, 2, 3]);
		const out = resampleLinear(input, 16_000, 16_000);
		expect([...out]).toEqual([1, 2, 3]);
		expect(out).not.toBe(input);
	});

	it('halves the length going from 48k to 24k', () => {
		const input = new Float32Array(480);
		expect(resampleLinear(input, 48_000, 24_000).length).toBe(240);
	});

	it('thirds the length going from 48k to 16k, the realtime rate', () => {
		const input = new Float32Array(4800);
		expect(resampleLinear(input, 48_000, 16_000).length).toBe(1600);
	});

	it('preserves a constant signal', () => {
		const input = new Float32Array(300).fill(0.5);
		const out = resampleLinear(input, 48_000, 16_000);
		for (const sample of out) expect(sample).toBeCloseTo(0.5, 6);
	});

	it('preserves a linear ramp, which linear interpolation should do exactly', () => {
		const input = Float32Array.from({ length: 100 }, (_unused, i) => i / 100);
		const out = resampleLinear(input, 100, 50);
		for (let i = 0; i < out.length; i += 1) {
			expect(out[i]).toBeCloseTo((i * 2) / 100, 6);
		}
	});

	it('upsamples as well as downsamples', () => {
		const input = new Float32Array([0, 1]);
		expect(resampleLinear(input, 8_000, 16_000).length).toBe(4);
	});

	it('handles an empty buffer', () => {
		expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0);
	});

	it('never reads past the end of the input', () => {
		const input = Float32Array.from({ length: 97 }, (_unused, i) => i);
		const out = resampleLinear(input, 44_100, 16_000);
		expect(out.every((v) => Number.isFinite(v))).toBe(true);
	});
});

describe('concatFloat32', () => {
	it('joins chunks in order', () => {
		const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]);
		expect([...out]).toEqual([1, 2, 3]);
	});

	it('returns an empty buffer for no chunks', () => {
		expect(concatFloat32([]).length).toBe(0);
	});
});

describe('rms', () => {
	it('is zero for silence', () => {
		expect(rms(new Float32Array(128))).toBe(0);
	});

	it('is the amplitude for a constant signal', () => {
		expect(rms(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6);
	});

	it('is zero-length safe', () => {
		expect(rms(new Float32Array(0))).toBe(0);
	});
});

describe('encodeWav', () => {
	const pcm = new Int16Array([0, 1000, -1000, 32767]);
	const view = new DataView(encodeWav(pcm, 16_000));
	const ascii = (offset: number, length: number) =>
		String.fromCharCode(...new Uint8Array(view.buffer, offset, length));

	it('writes the RIFF/WAVE chunk identifiers', () => {
		expect(ascii(0, 4)).toBe('RIFF');
		expect(ascii(8, 4)).toBe('WAVE');
		expect(ascii(12, 4)).toBe('fmt ');
		expect(ascii(36, 4)).toBe('data');
	});

	it('writes a real chunk size, not the reference server placeholder', () => {
		expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
		expect(view.getUint32(4, true)).not.toBe(0xffffffff);
	});

	it('declares mono 16-bit PCM at the requested rate', () => {
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // channels
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint32(28, true)).toBe(32_000); // byte rate
		expect(view.getUint16(32, true)).toBe(2); // block align
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
	});

	it('writes the samples little-endian after the 44 byte header', () => {
		expect(view.getUint32(40, true)).toBe(pcm.length * 2);
		for (let i = 0; i < pcm.length; i += 1) {
			expect(view.getInt16(44 + i * 2, true)).toBe(pcm[i]);
		}
	});
});

describe('pcm16ToBase64', () => {
	it('encodes little-endian samples', () => {
		// 1 -> 0x01 0x00, 256 -> 0x00 0x01
		expect(pcm16ToBase64(new Int16Array([1, 256]))).toBe(btoa('\x01\x00\x00\x01'));
	});

	it('handles a buffer longer than one chunk without throwing', () => {
		const long = new Int16Array(100_000).fill(1234);
		expect(() => pcm16ToBase64(long)).not.toThrow();
		expect(pcm16ToBase64(long).length).toBeGreaterThan(0);
	});
});
