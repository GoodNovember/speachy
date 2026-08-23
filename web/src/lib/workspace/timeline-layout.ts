import {
	selectTimedAnnotations,
	type TimedAnnotation,
	type TimedAnnotationDocument
} from './timed-annotations';
import { waveformXForTime } from './waveform';

export type TranscriptAnnotation = Extract<
	TimedAnnotation,
	{ kind: 'transcript-segment' | 'transcript-word' }
>;

export type TranscriptTimelineItem = TranscriptAnnotation & {
	left: number;
	width: number;
};

export type TranscriptTimelineLayout = {
	segments: TranscriptTimelineItem[];
	words: TranscriptTimelineItem[];
};

function isTranscriptAnnotation(annotation: TimedAnnotation): annotation is TranscriptAnnotation {
	return annotation.kind === 'transcript-segment' || annotation.kind === 'transcript-word';
}

function projectAnnotation(
	annotation: TranscriptAnnotation,
	duration: number,
	renderWidth: number
): TranscriptTimelineItem {
	const left = waveformXForTime(annotation.start, duration, renderWidth);
	const right = waveformXForTime(annotation.end, duration, renderWidth);
	return { ...annotation, left, width: Math.max(0, right - left) };
}

export function projectTranscriptTimeline(
	document: TimedAnnotationDocument | null,
	duration: number,
	renderWidth: number
): TranscriptTimelineLayout {
	if (document === null || !(duration > 0) || !(renderWidth > 0)) {
		return { segments: [], words: [] };
	}

	const projected = selectTimedAnnotations(document)
		.filter(isTranscriptAnnotation)
		.map((annotation) => projectAnnotation(annotation, duration, renderWidth));

	return {
		segments: projected.filter(({ kind }) => kind === 'transcript-segment'),
		words: projected.filter(({ kind }) => kind === 'transcript-word')
	};
}
