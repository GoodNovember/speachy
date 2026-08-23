import { describe, expect, it } from 'vitest';
import { scoreDiarization, type DiarizationSegment } from './diarization-quality.ts';

const options = { duration: 4, collarSeconds: 0, skipOverlap: false };

describe('diarization quality scoring', () => {
	it('uses optimal label mapping so anonymous speaker names do not matter', () => {
		const reference: DiarizationSegment[] = [
			{ start: 0, end: 2, speaker: 'alice' },
			{ start: 2, end: 4, speaker: 'bob' }
		];
		const hypothesis: DiarizationSegment[] = [
			{ start: 0, end: 2, speaker: 'SPEAKER_01' },
			{ start: 2, end: 4, speaker: 'SPEAKER_00' }
		];
		const result = scoreDiarization(reference, hypothesis, options);
		expect(result.mapping).toEqual({ SPEAKER_00: 'bob', SPEAKER_01: 'alice' });
		expect(result.diarizationErrorRate).toBe(0);
		expect(result.jaccardErrorRate).toBe(0);
	});

	it('decomposes false alarm, missed speech, and confusion as speaker-time', () => {
		const reference: DiarizationSegment[] = [
			{ start: 0, end: 2, speaker: 'a' },
			{ start: 1, end: 3, speaker: 'b' }
		];
		const hypothesis: DiarizationSegment[] = [
			{ start: 0, end: 3, speaker: 'one' },
			{ start: 3, end: 4, speaker: 'extra' }
		];
		const result = scoreDiarization(reference, hypothesis, options);
		expect(result.referenceSpeakerTime).toBe(4);
		expect(result.falseAlarm).toBe(1);
		expect(result.missedSpeech).toBe(1);
		expect(result.confusion).toBe(1);
		expect(result.diarizationErrorRate).toBe(0.75);
	});

	it('reports overlap detection separately and can exclude overlap from DER', () => {
		const reference: DiarizationSegment[] = [
			{ start: 0, end: 2, speaker: 'a' },
			{ start: 1, end: 3, speaker: 'b' }
		];
		const hypothesis: DiarizationSegment[] = [{ start: 0, end: 3, speaker: 'one' }];
		const included = scoreDiarization(reference, hypothesis, options);
		const excluded = scoreDiarization(reference, hypothesis, { ...options, skipOverlap: true });
		expect(included.overlap).toEqual({
			referenceDuration: 1,
			hypothesisDuration: 0,
			intersectionDuration: 0,
			precision: 0,
			recall: 0
		});
		expect(included.missedSpeech).toBe(1);
		expect(included.diarizationErrorRate).toBe(0.5);
		expect(included.jaccardErrorRate).toBeCloseTo(2 / 3);
		expect(excluded.missedSpeech).toBe(0);
		expect(excluded.excludedTimelineDuration).toBe(1);
	});

	it('interprets a 0.5 second centered collar as 0.25 seconds on each side', () => {
		const reference: DiarizationSegment[] = [{ start: 1, end: 3, speaker: 'a' }];
		const hypothesis: DiarizationSegment[] = [{ start: 1.2, end: 2.8, speaker: 'one' }];
		const noCollar = scoreDiarization(reference, hypothesis, options);
		const collar = scoreDiarization(reference, hypothesis, {
			...options,
			collarSeconds: 0.5
		});
		expect(noCollar.diarizationErrorRate).toBeCloseTo(0.2);
		expect(collar.options.boundaryToleranceEachSideSeconds).toBe(0.25);
		expect(collar.diarizationErrorRate).toBe(0);
	});

	it('rejects invalid ranges instead of clipping score inputs silently', () => {
		expect(() => scoreDiarization([{ start: -1, end: 1, speaker: 'a' }], [], options)).toThrow(
			'Invalid reference'
		);
		expect(() => scoreDiarization([], [{ start: 3, end: 5, speaker: 'one' }], options)).toThrow(
			'Invalid hypothesis'
		);
	});
});
