import { describe, expect, it } from 'vitest';
import {
	calculateWaveformPeaks,
	formatWaveformTime,
	waveformRasterWidth,
	waveformRenderWidth,
	waveformTimeForX,
	waveformXForTime
} from './waveform.ts';

describe('workspace waveform maths', () => {
	it('sizes the scrollable surface from duration without compressing long recordings', () => {
		expect(waveformRenderWidth(2)).toBe(720);
		expect(waveformRenderWidth(10)).toBe(960);
		expect(waveformRenderWidth(60 * 60)).toBe(345_600);
		expect(() => waveformRenderWidth(-1)).toThrow('Invalid audio duration');
		expect(() => waveformRenderWidth(1, 0)).toThrow('Invalid waveform pixel density');
	});

	it('bounds only the raster work, not the native scroll length', () => {
		expect(waveformRasterWidth(960)).toBe(960);
		expect(waveformRasterWidth(345_600)).toBe(32_760);
		expect(() => waveformRasterWidth(0)).toThrow('Invalid waveform render width');
	});

	it('maps seek positions and times through the same clamped scale', () => {
		expect(waveformXForTime(2.5, 10, 1_000)).toBe(250);
		expect(waveformXForTime(20, 10, 1_000)).toBe(1_000);
		expect(waveformTimeForX(250, 10, 1_000)).toBe(2.5);
		expect(waveformTimeForX(-20, 10, 1_000)).toBe(0);
		expect(waveformTimeForX(2_000, 10, 1_000)).toBe(10);
	});

	it('extracts minimum and maximum peaks for each rendered pixel', () => {
		const peaks = calculateWaveformPeaks([new Float32Array([-1, -0.5, 0.5, 1])], 2);
		expect([...peaks]).toEqual([-1, -0.5, 0.5, 1]);
	});

	it('mixes channels before peak extraction without changing the source arrays', () => {
		const left = new Float32Array([1, -1]);
		const right = new Float32Array([-0.5, 0.5]);
		const peaks = calculateWaveformPeaks([left, right], 2);
		expect([...peaks]).toEqual([0.25, 0.25, -0.25, -0.25]);
		expect([...left]).toEqual([1, -1]);
		expect([...right]).toEqual([-0.5, 0.5]);
	});

	it('replicates frames at high zoom and handles empty channel data', () => {
		expect([...calculateWaveformPeaks([new Float32Array([0.5])], 3)]).toEqual([
			0.5, 0.5, 0.5, 0.5, 0.5, 0.5
		]);
		expect([...calculateWaveformPeaks([], 2)]).toEqual([0, 0, 0, 0]);
	});

	it('formats the shared playhead time consistently', () => {
		expect(formatWaveformTime(0)).toBe('0:00.0');
		expect(formatWaveformTime(65.28)).toBe('1:05.3');
		expect(formatWaveformTime(Number.NaN)).toBe('0:00.0');
	});
});
