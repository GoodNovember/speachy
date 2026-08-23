import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/workspace/timed-annotation-events.json';
import {
	applyTimedAnnotationEvent,
	createTimedAnnotationDocument,
	replayTimedAnnotationEvents,
	selectTimedAnnotations
} from './timed-annotations.ts';

describe('timed annotation model', () => {
	it('replays the fixture as provisional revisions and final annotations', () => {
		const result = replayTimedAnnotationEvents(fixture.events);

		expect(result.issues).toEqual([]);
		expect(result.document).toMatchObject({ schemaVersion: 1, revision: 10 });
		expect(selectTimedAnnotations(result.document).map((annotation) => annotation.id)).toEqual([
			'turn-1',
			'segment-1',
			'word-1',
			'word-2',
			'turn-2'
		]);
		expect(selectTimedAnnotations(result.document).every(({ status }) => status === 'final')).toBe(
			true
		);
		expect(selectTimedAnnotations(result.document, { kind: 'transcript-word' })).toMatchObject([
			{ id: 'word-1', start: 0.12, end: 0.58, text: 'We', revision: 2 },
			{ id: 'word-2', start: 0.6, end: 1.14, text: 'should', revision: 0 }
		]);
		expect(selectTimedAnnotations(result.document, { kind: 'speaker-turn' })).toMatchObject([
			{ id: 'turn-1', end: 1.5, speaker: 'SPEAKER_00', revision: 2 },
			{ id: 'turn-2', start: 1.2, speaker: 'SPEAKER_01', revision: 0 }
		]);
	});

	it('returns new documents while leaving earlier provisional snapshots unchanged', () => {
		const empty = createTimedAnnotationDocument();
		const added = applyTimedAnnotationEvent(empty, fixture.events[0]);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const revised = applyTimedAnnotationEvent(added.document, {
			type: 'revise',
			annotation: {
				id: 'segment-1',
				kind: 'transcript-segment',
				start: 0.2,
				end: 2.9,
				text: 'Revised text.'
			}
		});

		expect(revised.ok).toBe(true);
		expect(empty).toEqual({ schemaVersion: 1, revision: 0, annotations: [] });
		expect(added.document.annotations[0]).toMatchObject({
			start: 0.1,
			text: 'We should try the smaller model.',
			revision: 0
		});
		if (revised.ok) {
			expect(revised.annotation).toMatchObject({
				start: 0.2,
				text: 'Revised text.',
				revision: 1,
				status: 'provisional'
			});
		}
	});

	it('rejects duplicate, missing, kind-changing, and post-final events without mutation', () => {
		const replayed = replayTimedAnnotationEvents([
			fixture.events[0],
			fixture.events[9],
			fixture.events[0],
			{ type: 'finalize', id: 'missing' },
			{
				type: 'revise',
				annotation: {
					id: 'segment-1',
					kind: 'speaker-turn',
					start: 0,
					end: 1,
					speaker: 'SPEAKER_00'
				}
			}
		]);

		expect(replayed.document.revision).toBe(2);
		expect(replayed.issues.map(({ code }) => code)).toEqual([
			'duplicate-id',
			'missing-target',
			'already-final'
		]);
	});

	it('rejects a kind change while an annotation is provisional', () => {
		const result = replayTimedAnnotationEvents([
			fixture.events[0],
			{
				type: 'revise',
				annotation: {
					id: 'segment-1',
					kind: 'speaker-turn',
					start: 0,
					end: 1,
					speaker: 'SPEAKER_00'
				}
			}
		]);

		expect(result.document.revision).toBe(1);
		expect(result.issues).toMatchObject([{ code: 'kind-mismatch', eventIndex: 1 }]);
	});

	it('reports invalid external events without throwing or dropping valid neighbors', () => {
		const result = replayTimedAnnotationEvents([
			fixture.events[1],
			{
				type: 'revise',
				annotation: {
					id: 'word-1',
					kind: 'transcript-word',
					start: Number.NaN,
					end: 0.8,
					text: 'invalid'
				}
			},
			fixture.events[3]
		]);

		expect(result.document.revision).toBe(2);
		expect(result.issues).toMatchObject([
			{
				code: 'invalid-event',
				eventIndex: 1,
				validation: [{ path: ['annotation', 'start'] }]
			}
		]);
		expect(selectTimedAnnotations(result.document)).toMatchObject([
			{ id: 'word-1', status: 'final', revision: 1 }
		]);
	});

	it('preserves finite but suspicious source timings for downstream diagnostics', () => {
		const result = replayTimedAnnotationEvents([
			{
				type: 'add',
				final: true,
				annotation: {
					id: 'early-word',
					kind: 'transcript-word',
					start: -0.1,
					end: 0.2,
					text: 'early'
				}
			},
			{
				type: 'add',
				final: true,
				annotation: {
					id: 'reversed-turn',
					kind: 'speaker-turn',
					start: 2,
					end: 1,
					speaker: 'SPEAKER_00'
				}
			}
		]);

		expect(result.issues).toEqual([]);
		expect(selectTimedAnnotations(result.document)).toMatchObject([
			{ id: 'early-word', start: -0.1, end: 0.2 },
			{ id: 'reversed-turn', start: 2, end: 1 }
		]);
	});

	it('filters provisional state and deterministically orders equal intervals', () => {
		const result = replayTimedAnnotationEvents([
			{
				type: 'add',
				annotation: {
					id: 'turn-z',
					kind: 'speaker-turn',
					start: 1,
					end: 2,
					speaker: 'B'
				}
			},
			{
				type: 'add',
				annotation: {
					id: 'word-a',
					kind: 'transcript-word',
					start: 1,
					end: 2,
					text: 'same interval'
				}
			},
			{
				type: 'add',
				final: true,
				annotation: {
					id: 'segment-a',
					kind: 'transcript-segment',
					start: 1,
					end: 2,
					text: 'same interval'
				}
			}
		]);

		expect(
			selectTimedAnnotations(result.document, { status: 'provisional' }).map(({ id }) => id)
		).toEqual(['word-a', 'turn-z']);
		expect(selectTimedAnnotations(result.document).map(({ id }) => id)).toEqual([
			'segment-a',
			'word-a',
			'turn-z'
		]);
	});
});
