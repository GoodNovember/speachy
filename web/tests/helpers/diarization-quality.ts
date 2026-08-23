export type DiarizationSegment = {
	start: number;
	end: number;
	speaker: string;
};

export type DiarizationScoreOptions = {
	duration: number;
	collarSeconds: number;
	skipOverlap: boolean;
};

type Interval = { start: number; end: number };

function validateSegments(
	segments: readonly DiarizationSegment[],
	duration: number,
	name: string
): void {
	if (!Number.isFinite(duration) || duration <= 0)
		throw new RangeError('duration must be positive');
	for (const segment of segments) {
		if (
			!Number.isFinite(segment.start) ||
			!Number.isFinite(segment.end) ||
			segment.start < 0 ||
			segment.end <= segment.start ||
			segment.end > duration ||
			segment.speaker.length === 0
		) {
			throw new Error(`Invalid ${name} diarization segment`);
		}
	}
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
	const sorted = intervals
		.filter((interval) => interval.end > interval.start)
		.toSorted((left, right) => left.start - right.start || left.end - right.end);
	const merged: Interval[] = [];
	for (const interval of sorted) {
		const previous = merged.at(-1);
		if (previous === undefined || interval.start > previous.end) {
			merged.push({ ...interval });
		} else {
			previous.end = Math.max(previous.end, interval.end);
		}
	}
	return merged;
}

function activeSpeakers(segments: readonly DiarizationSegment[], time: number): string[] {
	return [
		...new Set(
			segments
				.filter((segment) => segment.start <= time && time < segment.end)
				.map((segment) => segment.speaker)
		)
	].sort();
}

function overlapIntervals(segments: readonly DiarizationSegment[], duration: number): Interval[] {
	const boundaries = [
		0,
		duration,
		...segments.flatMap((segment) => [segment.start, segment.end])
	].toSorted((left, right) => left - right);
	const intervals: Interval[] = [];
	for (let index = 1; index < boundaries.length; index += 1) {
		const start = boundaries[index - 1]!;
		const end = boundaries[index]!;
		if (end <= start || activeSpeakers(segments, (start + end) / 2).length < 2) continue;
		intervals.push({ start, end });
	}
	return mergeIntervals(intervals);
}

function intervalDuration(intervals: readonly Interval[]): number {
	return intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
}

function intersectionDuration(left: readonly Interval[], right: readonly Interval[]): number {
	let total = 0;
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const a = left[leftIndex]!;
		const b = right[rightIndex]!;
		total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
		if (a.end <= b.end) leftIndex += 1;
		else rightIndex += 1;
	}
	return total;
}

function scoreIntervals(
	reference: readonly DiarizationSegment[],
	hypothesis: readonly DiarizationSegment[],
	options: DiarizationScoreOptions
) {
	if (!Number.isFinite(options.collarSeconds) || options.collarSeconds < 0) {
		throw new RangeError('collarSeconds must be non-negative');
	}
	const exclusions: Interval[] = [];
	const halfCollar = options.collarSeconds / 2;
	if (halfCollar > 0) {
		for (const segment of reference) {
			for (const boundary of [segment.start, segment.end]) {
				exclusions.push({
					start: Math.max(0, boundary - halfCollar),
					end: Math.min(options.duration, boundary + halfCollar)
				});
			}
		}
	}
	if (options.skipOverlap) exclusions.push(...overlapIntervals(reference, options.duration));
	const excluded = mergeIntervals(exclusions);
	const boundaries = [
		0,
		options.duration,
		...reference.flatMap((segment) => [segment.start, segment.end]),
		...hypothesis.flatMap((segment) => [segment.start, segment.end]),
		...excluded.flatMap((interval) => [interval.start, interval.end])
	].toSorted((left, right) => left - right);
	const intervals: {
		start: number;
		end: number;
		reference: string[];
		hypothesis: string[];
	}[] = [];
	for (let index = 1; index < boundaries.length; index += 1) {
		const start = boundaries[index - 1]!;
		const end = boundaries[index]!;
		if (end <= start) continue;
		const midpoint = (start + end) / 2;
		if (excluded.some((interval) => interval.start <= midpoint && midpoint < interval.end))
			continue;
		intervals.push({
			start,
			end,
			reference: activeSpeakers(reference, midpoint),
			hypothesis: activeSpeakers(hypothesis, midpoint)
		});
	}
	return { intervals, excludedDuration: intervalDuration(excluded) };
}

function optimalMapping(
	intervals: ReturnType<typeof scoreIntervals>['intervals'],
	referenceSpeakers: readonly string[],
	hypothesisSpeakers: readonly string[]
): Record<string, string> {
	if (referenceSpeakers.length > 20) {
		throw new Error('The exact speaker mapper supports at most 20 reference speakers');
	}
	const overlap = hypothesisSpeakers.map((hypothesisSpeaker) =>
		referenceSpeakers.map((referenceSpeaker) =>
			intervals.reduce(
				(total, interval) =>
					total +
					(interval.hypothesis.includes(hypothesisSpeaker) &&
					interval.reference.includes(referenceSpeaker)
						? interval.end - interval.start
						: 0),
				0
			)
		)
	);
	type Result = { score: number; pairs: [number, number][] };
	const memo = new Map<string, Result>();
	const search = (hypothesisIndex: number, usedReferences: number): Result => {
		if (hypothesisIndex === hypothesisSpeakers.length) return { score: 0, pairs: [] };
		const key = `${hypothesisIndex}:${usedReferences}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let best = search(hypothesisIndex + 1, usedReferences);
		for (let referenceIndex = 0; referenceIndex < referenceSpeakers.length; referenceIndex += 1) {
			const bit = 1 << referenceIndex;
			if ((usedReferences & bit) !== 0) continue;
			const rest = search(hypothesisIndex + 1, usedReferences | bit);
			const candidate = {
				score: overlap[hypothesisIndex]![referenceIndex]! + rest.score,
				pairs: [[hypothesisIndex, referenceIndex] as [number, number], ...rest.pairs]
			};
			if (candidate.score > best.score) best = candidate;
		}
		memo.set(key, best);
		return best;
	};
	return Object.fromEntries(
		search(0, 0).pairs.map(([hypothesisIndex, referenceIndex]) => [
			hypothesisSpeakers[hypothesisIndex]!,
			referenceSpeakers[referenceIndex]!
		])
	);
}

export function scoreDiarization(
	reference: readonly DiarizationSegment[],
	hypothesis: readonly DiarizationSegment[],
	options: DiarizationScoreOptions
) {
	validateSegments(reference, options.duration, 'reference');
	validateSegments(hypothesis, options.duration, 'hypothesis');
	const referenceSpeakers = [...new Set(reference.map((segment) => segment.speaker))].sort();
	const hypothesisSpeakers = [...new Set(hypothesis.map((segment) => segment.speaker))].sort();
	const { intervals, excludedDuration } = scoreIntervals(reference, hypothesis, options);
	const mapping = optimalMapping(intervals, referenceSpeakers, hypothesisSpeakers);
	let total = 0;
	let falseAlarm = 0;
	let missedSpeech = 0;
	let confusion = 0;
	for (const interval of intervals) {
		const duration = interval.end - interval.start;
		const mappedHypothesis = interval.hypothesis.flatMap((speaker) =>
			mapping[speaker] === undefined ? [] : [mapping[speaker]]
		);
		const correct = mappedHypothesis.filter((speaker) =>
			interval.reference.includes(speaker)
		).length;
		total += duration * interval.reference.length;
		falseAlarm += duration * Math.max(0, interval.hypothesis.length - interval.reference.length);
		missedSpeech += duration * Math.max(0, interval.reference.length - interval.hypothesis.length);
		confusion +=
			duration * (Math.min(interval.reference.length, interval.hypothesis.length) - correct);
	}
	const error = falseAlarm + missedSpeech + confusion;
	const inverseMapping = Object.fromEntries(
		Object.entries(mapping).map(([hypothesisSpeaker, referenceSpeaker]) => [
			referenceSpeaker,
			hypothesisSpeaker
		])
	);
	const speakerJaccardErrors = referenceSpeakers.map((referenceSpeaker) => {
		const hypothesisSpeaker = inverseMapping[referenceSpeaker];
		if (hypothesisSpeaker === undefined) return { speaker: referenceSpeaker, error: 1 };
		let intersection = 0;
		let union = 0;
		for (const interval of intervals) {
			const duration = interval.end - interval.start;
			const inReference = interval.reference.includes(referenceSpeaker);
			const inHypothesis = interval.hypothesis.includes(hypothesisSpeaker);
			if (inReference && inHypothesis) intersection += duration;
			if (inReference || inHypothesis) union += duration;
		}
		return { speaker: referenceSpeaker, error: union === 0 ? 1 : 1 - intersection / union };
	});
	const referenceOverlap = overlapIntervals(reference, options.duration);
	const hypothesisOverlap = overlapIntervals(hypothesis, options.duration);
	const overlapIntersection = intersectionDuration(referenceOverlap, hypothesisOverlap);
	const referenceOverlapDuration = intervalDuration(referenceOverlap);
	const hypothesisOverlapDuration = intervalDuration(hypothesisOverlap);
	return {
		options: {
			...options,
			boundaryToleranceEachSideSeconds: options.collarSeconds / 2
		},
		mapping,
		referenceSpeakerCount: referenceSpeakers.length,
		hypothesisSpeakerCount: hypothesisSpeakers.length,
		scoredTimelineDuration: intervalDuration(intervals),
		excludedTimelineDuration: excludedDuration,
		referenceSpeakerTime: total,
		falseAlarm,
		missedSpeech,
		confusion,
		error,
		diarizationErrorRate: total === 0 ? (error === 0 ? 0 : 1) : error / total,
		jaccardErrorRate:
			speakerJaccardErrors.length === 0
				? 0
				: speakerJaccardErrors.reduce((sum, speaker) => sum + speaker.error, 0) /
					speakerJaccardErrors.length,
		speakerJaccardErrors,
		overlap: {
			referenceDuration: referenceOverlapDuration,
			hypothesisDuration: hypothesisOverlapDuration,
			intersectionDuration: overlapIntersection,
			precision:
				hypothesisOverlapDuration === 0
					? referenceOverlapDuration === 0
						? 1
						: 0
					: overlapIntersection / hypothesisOverlapDuration,
			recall:
				referenceOverlapDuration === 0
					? hypothesisOverlapDuration === 0
						? 1
						: 0
					: overlapIntersection / referenceOverlapDuration
		}
	};
}
