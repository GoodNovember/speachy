import { describe, expect, it } from 'vitest';
import { replayTimedAnnotationEvents } from './timed-annotations.ts';
import { projectTranscriptTimeline } from './timeline-layout.ts';

const document = replayTimedAnnotationEvents([
	{
		type: 'add',
		final: true,
		annotation: {
			id: 'segment-1',
			kind: 'transcript-segment',
			start: 1,
			end: 4,
			text: 'Align these words.'
		}
	},
	{
		type: 'add',
		annotation: {
			id: 'word-1',
			kind: 'transcript-word',
			start: 1,
			end: 1.5,
			text: 'Align'
		}
	},
	{
		type: 'add',
		final: true,
		annotation: {
			id: 'word-2',
			kind: 'transcript-word',
			start: 2,
			end: 2.75,
			text: 'these'
		}
	},
	{
		type: 'add',
		final: true,
		annotation: {
			id: 'turn-1',
			kind: 'speaker-turn',
			start: 0,
			end: 5,
			speaker: 'SPEAKER_00'
		}
	}
]).document;

describe('transcript timeline projection', () => {
	it('aligns segments and words through the waveform time scale', () => {
		const layout = projectTranscriptTimeline(document, 10, 960);

		expect(layout.segments).toMatchObject([
			{ id: 'segment-1', left: 96, width: 288, text: 'Align these words.' }
		]);
		expect(layout.words).toMatchObject([
			{ id: 'word-1', left: 96, width: 48, text: 'Align' },
			{ id: 'word-2', left: 192, width: 72, text: 'these' }
		]);
		expect(layout.segments[0]!.left).toBe(layout.words[0]!.left);
	});

	it('retains revision state and excludes speaker turns from transcript lanes', () => {
		const layout = projectTranscriptTimeline(document, 10, 960);

		expect(layout.words[0]).toMatchObject({ status: 'provisional', revision: 0 });
		expect([...layout.segments, ...layout.words].map(({ id }) => id)).not.toContain('turn-1');
	});

	it('clamps only projected geometry while preserving suspicious source timings', () => {
		const suspicious = replayTimedAnnotationEvents([
			{
				type: 'add',
				final: true,
				annotation: {
					id: 'outside',
					kind: 'transcript-word',
					start: -1,
					end: 12,
					text: 'outside'
				}
			}
		]).document;

		const [item] = projectTranscriptTimeline(suspicious, 10, 960).words;
		expect(item).toMatchObject({ start: -1, end: 12, left: 0, width: 960 });
		expect(suspicious.annotations[0]).toMatchObject({ start: -1, end: 12 });
	});

	it('returns empty lanes before duration is available', () => {
		expect(projectTranscriptTimeline(document, 0, 720)).toEqual({ segments: [], words: [] });
		expect(projectTranscriptTimeline(null, 10, 960)).toEqual({ segments: [], words: [] });
	});
});
