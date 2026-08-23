import { z } from 'zod';

export const TIMED_ANNOTATION_SCHEMA_VERSION = 1;

const annotationBase = {
	id: z.string().min(1),
	// Range and cross-annotation correctness belong to timeline diagnostics.
	// Keeping finite source timings unchanged lets the inspector report bad
	// intervals without silently repairing the inference result.
	start: z.number().finite(),
	end: z.number().finite()
};

export const transcriptWordInputSchema = z.strictObject({
	...annotationBase,
	kind: z.literal('transcript-word'),
	text: z.string()
});

export const transcriptSegmentInputSchema = z.strictObject({
	...annotationBase,
	kind: z.literal('transcript-segment'),
	text: z.string()
});

export const speakerTurnInputSchema = z.strictObject({
	...annotationBase,
	kind: z.literal('speaker-turn'),
	speaker: z.string()
});

export const timedAnnotationInputSchema = z.discriminatedUnion('kind', [
	transcriptWordInputSchema,
	transcriptSegmentInputSchema,
	speakerTurnInputSchema
]);

export type TimedAnnotationInput = z.infer<typeof timedAnnotationInputSchema>;
export type TimedAnnotationKind = TimedAnnotationInput['kind'];
export type TimedAnnotationStatus = 'provisional' | 'final';

export type TimedAnnotation = TimedAnnotationInput & {
	status: TimedAnnotationStatus;
	revision: number;
};

export const timedAnnotationEventSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('add'),
		annotation: timedAnnotationInputSchema,
		final: z.boolean().optional()
	}),
	z.strictObject({
		type: z.literal('revise'),
		annotation: timedAnnotationInputSchema
	}),
	z.strictObject({
		type: z.literal('finalize'),
		id: z.string().min(1)
	})
]);

export type TimedAnnotationEvent = z.infer<typeof timedAnnotationEventSchema>;

export type TimedAnnotationDocument = {
	schemaVersion: typeof TIMED_ANNOTATION_SCHEMA_VERSION;
	revision: number;
	annotations: readonly TimedAnnotation[];
};

export type TimedAnnotationIssueCode =
	'invalid-event' | 'duplicate-id' | 'missing-target' | 'kind-mismatch' | 'already-final';

export type TimedAnnotationIssue = {
	code: TimedAnnotationIssueCode;
	message: string;
	id?: string;
	eventIndex?: number;
	validation?: { path: string[]; message: string }[];
};

export type ApplyTimedAnnotationResult =
	| {
			ok: true;
			document: TimedAnnotationDocument;
			annotation: TimedAnnotation;
	  }
	| {
			ok: false;
			document: TimedAnnotationDocument;
			issue: TimedAnnotationIssue;
	  };

export function createTimedAnnotationDocument(): TimedAnnotationDocument {
	return {
		schemaVersion: TIMED_ANNOTATION_SCHEMA_VERSION,
		revision: 0,
		annotations: []
	};
}

function accepted(
	document: TimedAnnotationDocument,
	annotations: readonly TimedAnnotation[],
	annotation: TimedAnnotation
): ApplyTimedAnnotationResult {
	return {
		ok: true,
		document: {
			...document,
			revision: document.revision + 1,
			annotations
		},
		annotation
	};
}

function rejected(
	document: TimedAnnotationDocument,
	issue: TimedAnnotationIssue
): ApplyTimedAnnotationResult {
	return { ok: false, document, issue };
}

function annotationIndex(document: TimedAnnotationDocument, id: string): number {
	return document.annotations.findIndex((annotation) => annotation.id === id);
}

export function applyTimedAnnotationEvent(
	document: TimedAnnotationDocument,
	input: unknown
): ApplyTimedAnnotationResult {
	const parsed = timedAnnotationEventSchema.safeParse(input);
	if (!parsed.success) {
		return rejected(document, {
			code: 'invalid-event',
			message: 'Timed annotation event is invalid.',
			validation: parsed.error.issues.map((issue) => ({
				path: issue.path.map(String),
				message: issue.message
			}))
		});
	}

	const event = parsed.data;
	if (event.type === 'add') {
		if (annotationIndex(document, event.annotation.id) !== -1) {
			return rejected(document, {
				code: 'duplicate-id',
				id: event.annotation.id,
				message: `Annotation '${event.annotation.id}' already exists.`
			});
		}
		const annotation: TimedAnnotation = {
			...event.annotation,
			status: event.final === true ? 'final' : 'provisional',
			revision: 0
		};
		return accepted(document, [...document.annotations, annotation], annotation);
	}

	const id = event.type === 'finalize' ? event.id : event.annotation.id;
	const index = annotationIndex(document, id);
	if (index === -1) {
		return rejected(document, {
			code: 'missing-target',
			id,
			message: `Annotation '${id}' does not exist.`
		});
	}

	const current = document.annotations[index]!;
	if (current.status === 'final') {
		return rejected(document, {
			code: 'already-final',
			id,
			message: `Annotation '${id}' is already final.`
		});
	}

	let annotation: TimedAnnotation;
	if (event.type === 'revise') {
		if (event.annotation.kind !== current.kind) {
			return rejected(document, {
				code: 'kind-mismatch',
				id,
				message: `Annotation '${id}' cannot change kind from '${current.kind}' to '${event.annotation.kind}'.`
			});
		}
		annotation = {
			...event.annotation,
			status: 'provisional',
			revision: current.revision + 1
		};
	} else {
		annotation = { ...current, status: 'final', revision: current.revision + 1 };
	}

	const annotations = document.annotations.map((candidate, candidateIndex) =>
		candidateIndex === index ? annotation : candidate
	);
	return accepted(document, annotations, annotation);
}

export type ReplayTimedAnnotationResult = {
	document: TimedAnnotationDocument;
	issues: TimedAnnotationIssue[];
};

export function replayTimedAnnotationEvents(
	events: Iterable<unknown>,
	initial: TimedAnnotationDocument = createTimedAnnotationDocument()
): ReplayTimedAnnotationResult {
	let document = initial;
	const issues: TimedAnnotationIssue[] = [];
	let eventIndex = 0;
	for (const event of events) {
		const result = applyTimedAnnotationEvent(document, event);
		if (result.ok) document = result.document;
		else issues.push({ ...result.issue, eventIndex });
		eventIndex += 1;
	}
	return { document, issues };
}

export type TimedAnnotationFilter = {
	kind?: TimedAnnotationKind;
	status?: TimedAnnotationStatus;
};

const kindOrder: Record<TimedAnnotationKind, number> = {
	'transcript-segment': 0,
	'transcript-word': 1,
	'speaker-turn': 2
};

function compareAnnotations(left: TimedAnnotation, right: TimedAnnotation): number {
	return (
		left.start - right.start ||
		left.end - right.end ||
		kindOrder[left.kind] - kindOrder[right.kind] ||
		left.id.localeCompare(right.id, 'en-US')
	);
}

export function selectTimedAnnotations(
	document: TimedAnnotationDocument,
	filter: TimedAnnotationFilter = {}
): TimedAnnotation[] {
	return document.annotations
		.filter(
			(annotation) =>
				(filter.kind === undefined || annotation.kind === filter.kind) &&
				(filter.status === undefined || annotation.status === filter.status)
		)
		.toSorted(compareAnnotations);
}
