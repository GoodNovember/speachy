import {
	replayTimedAnnotationEvents,
	type TimedAnnotationDocument,
	type TimedAnnotationEvent
} from './timed-annotations';

type FixtureWord = readonly [id: string, start: number, end: number, text: string];

const fixtureWords: readonly FixtureWord[] = [
	['fixture-word-1', 0.12, 0.48, 'We'],
	['fixture-word-2', 0.52, 0.95, 'should'],
	['fixture-word-3', 1.02, 1.28, 'try'],
	['fixture-word-4', 1.34, 1.55, 'the'],
	['fixture-word-5', 1.62, 2.15, 'smaller'],
	['fixture-word-6', 2.22, 2.74, 'model.']
];

function wordEvent([id, start, end, text]: FixtureWord): TimedAnnotationEvent {
	return {
		type: 'add',
		final: true,
		annotation: { id, kind: 'transcript-word', start, end, text }
	};
}

export const WORKSPACE_TIMELINE_FIXTURE_EVENTS: readonly TimedAnnotationEvent[] = [
	{
		type: 'add',
		final: true,
		annotation: {
			id: 'fixture-segment-1',
			kind: 'transcript-segment',
			start: 0.1,
			end: 2.8,
			text: 'We should try the smaller model.'
		}
	},
	...fixtureWords.map(wordEvent)
];

const replayed = replayTimedAnnotationEvents(WORKSPACE_TIMELINE_FIXTURE_EVENTS);
if (replayed.issues.length > 0) throw new Error('Workspace timeline fixture is invalid');

export const WORKSPACE_TIMELINE_FIXTURE_DOCUMENT: TimedAnnotationDocument = replayed.document;
