import { z } from 'zod';

const stableIdSchema = z
	.string()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a stable lowercase hyphenated ID');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest');
const relativePathSchema = z.string().superRefine((value, context) => {
	if (
		value.length === 0 ||
		value.includes('\\') ||
		value.startsWith('/') ||
		/^[a-z]:/i.test(value) ||
		value.split('/').some((part) => part === '' || part === '.' || part === '..')
	) {
		context.addIssue({ code: 'custom', message: 'Expected a safe forward-slash relative path' });
	}
});
const finiteNonNegativeSchema = z.number().finite().nonnegative();
const timeRangeSchema = z
	.strictObject({ start: finiteNonNegativeSchema, end: finiteNonNegativeSchema })
	.refine((range) => range.end > range.start, { message: 'Range end must be after start' });
const annotationStatusSchema = z.enum(['unreviewed', 'silver', 'gold']);
const annotationsSchema = z.strictObject({
	transcript: annotationStatusSchema,
	speakerTurns: annotationStatusSchema
});

const sourceSchema = z.strictObject({
	id: stableIdSchema,
	chapter: z.number().int().positive(),
	audioFile: relativePathSchema,
	audioSha256: sha256Schema,
	mediaSourceUrl: z.url(),
	publicDomainUrl: z.url(),
	transcript: z.strictObject({
		status: annotationStatusSchema,
		sourceUrl: z.url(),
		sha256: sha256Schema
	})
});

const speakerSchema = z.strictObject({
	id: stableIdSchema,
	label: z.string().min(1),
	transform: z.strictObject({
		pitchSemitones: z.number().finite().min(-6).max(6),
		rate: z.number().finite().min(0.8).max(1.25),
		gainDb: z.number().finite().min(-24).max(6)
	})
});

const turnSchema = z.strictObject({
	id: stableIdSchema,
	speakerId: stableIdSchema,
	sourceId: stableIdSchema,
	sourceRange: timeRangeSchema,
	outputRange: timeRangeSchema,
	overlapGroup: stableIdSchema.nullable()
});

const scenarioSchema = z.strictObject({
	id: stableIdSchema,
	kind: z.enum(['clean-alternating', 'handoff', 'overlap', 'monologue']),
	outputRange: timeRangeSchema,
	turnIds: z.array(stableIdSchema).min(1)
});

export const syntheticConversationRecipeV1Schema = z
	.strictObject({
		kind: z.literal('speachy.synthetic-conversation-corpus'),
		schemaVersion: z.literal(1),
		id: stableIdSchema,
		title: z.string().min(1),
		language: z.string().regex(/^[a-z]{2,3}(?:-[a-z0-9]+)*$/),
		seed: z.number().int().nonnegative(),
		annotations: annotationsSchema,
		render: z.strictObject({
			duration: finiteNonNegativeSchema.positive(),
			sampleRate: z.number().int().positive(),
			channels: z.literal(1),
			format: z.literal('wav-pcm16')
		}),
		sources: z.array(sourceSchema).min(1),
		speakers: z.array(speakerSchema).min(2),
		turns: z.array(turnSchema).min(2),
		scenarios: z.array(scenarioSchema).min(1)
	})
	.superRefine((recipe, context) => {
		const sourceIds = new Set<string>();
		const speakerIds = new Set<string>();
		const turnIds = new Set<string>();
		const addUnique = (values: readonly { id: string }[], ids: Set<string>, path: string): void => {
			for (const [index, value] of values.entries()) {
				if (ids.has(value.id)) {
					context.addIssue({
						code: 'custom',
						message: `Duplicate ${path} ID '${value.id}'`,
						path: [path, index, 'id']
					});
				}
				ids.add(value.id);
			}
		};
		addUnique(recipe.sources, sourceIds, 'sources');
		addUnique(recipe.speakers, speakerIds, 'speakers');
		addUnique(recipe.turns, turnIds, 'turns');

		for (const [index, turn] of recipe.turns.entries()) {
			if (!sourceIds.has(turn.sourceId)) {
				context.addIssue({
					code: 'custom',
					message: `Unknown source ID '${turn.sourceId}'`,
					path: ['turns', index, 'sourceId']
				});
			}
			if (!speakerIds.has(turn.speakerId)) {
				context.addIssue({
					code: 'custom',
					message: `Unknown speaker ID '${turn.speakerId}'`,
					path: ['turns', index, 'speakerId']
				});
			}
			if (turn.outputRange.end > recipe.render.duration) {
				context.addIssue({
					code: 'custom',
					message: 'Turn extends beyond the declared render duration',
					path: ['turns', index, 'outputRange']
				});
			}
			const speaker = recipe.speakers.find((candidate) => candidate.id === turn.speakerId);
			if (speaker !== undefined) {
				const expectedDuration =
					(turn.sourceRange.end - turn.sourceRange.start) / speaker.transform.rate;
				const outputDuration = turn.outputRange.end - turn.outputRange.start;
				if (Math.abs(expectedDuration - outputDuration) > 2 / recipe.render.sampleRate) {
					context.addIssue({
						code: 'custom',
						message: 'Output duration does not match the speaker rate transform',
						path: ['turns', index, 'outputRange']
					});
				}
			}
			if (index > 0) {
				const previous = recipe.turns[index - 1]!;
				if (
					turn.outputRange.start < previous.outputRange.start ||
					(turn.outputRange.start === previous.outputRange.start && turn.id <= previous.id)
				) {
					context.addIssue({
						code: 'custom',
						message: 'Turns must have deterministic start-time and ID ordering',
						path: ['turns', index]
					});
				}
			}
		}

		for (const [index, scenario] of recipe.scenarios.entries()) {
			for (const turnId of scenario.turnIds) {
				if (!turnIds.has(turnId)) {
					context.addIssue({
						code: 'custom',
						message: `Unknown turn ID '${turnId}'`,
						path: ['scenarios', index, 'turnIds']
					});
				}
			}
			if (scenario.outputRange.end > recipe.render.duration) {
				context.addIssue({
					code: 'custom',
					message: 'Scenario extends beyond the declared render duration',
					path: ['scenarios', index, 'outputRange']
				});
			}
		}

		const overlapGroups = new Map<string, number[]>();
		for (const [index, turn] of recipe.turns.entries()) {
			if (turn.overlapGroup === null) continue;
			const members = overlapGroups.get(turn.overlapGroup) ?? [];
			members.push(index);
			overlapGroups.set(turn.overlapGroup, members);
		}
		for (const [group, members] of overlapGroups) {
			if (members.length !== 2) {
				context.addIssue({
					code: 'custom',
					message: `Overlap group '${group}' must have two turns`
				});
				continue;
			}
			const [left, right] = members.map((index) => recipe.turns[index]!);
			if (
				Math.min(left!.outputRange.end, right!.outputRange.end) <=
				Math.max(left!.outputRange.start, right!.outputRange.start)
			) {
				context.addIssue({ code: 'custom', message: `Overlap group '${group}' does not overlap` });
			}
		}
		for (let leftIndex = 0; leftIndex < recipe.turns.length; leftIndex += 1) {
			for (let rightIndex = leftIndex + 1; rightIndex < recipe.turns.length; rightIndex += 1) {
				const left = recipe.turns[leftIndex]!;
				const right = recipe.turns[rightIndex]!;
				const overlap =
					Math.min(left.outputRange.end, right.outputRange.end) -
					Math.max(left.outputRange.start, right.outputRange.start);
				if (overlap <= 1 / recipe.render.sampleRate) continue;
				if (left.overlapGroup === null || left.overlapGroup !== right.overlapGroup) {
					context.addIssue({
						code: 'custom',
						message: `Turns '${left.id}' and '${right.id}' overlap without one shared group`,
						path: ['turns', rightIndex, 'overlapGroup']
					});
				}
				if (left.speakerId === right.speakerId) {
					context.addIssue({
						code: 'custom',
						message: 'An overlap group must contain distinct speakers',
						path: ['turns', rightIndex, 'speakerId']
					});
				}
			}
		}
	});

export type SyntheticConversationRecipeV1 = z.infer<typeof syntheticConversationRecipeV1Schema>;

export const archiveTvNewsCorpusV1Schema = z
	.strictObject({
		kind: z.literal('speachy.archive-tv-news-corpus'),
		schemaVersion: z.literal(1),
		id: stableIdSchema,
		title: z.string().min(1),
		language: z.string().regex(/^[a-z]{2,3}(?:-[a-z0-9]+)*$/),
		annotations: annotationsSchema,
		clips: z
			.array(
				z.strictObject({
					id: stableIdSchema,
					archiveIdentifier: z.string().min(1),
					program: z.string().min(1),
					channel: z.string().min(1),
					airDate: z.iso.date(),
					sourceRange: timeRangeSchema,
					scenario: z.enum(['clean-report', 'interview', 'overlap-remote-noise']),
					captionStatus: z.enum(['unreviewed', 'silver', 'gold']),
					speakerTurnStatus: z.enum(['unreviewed', 'gold'])
				})
			)
			.min(1)
	})
	.superRefine((manifest, context) => {
		const ids = new Set<string>();
		for (const [index, clip] of manifest.clips.entries()) {
			if (ids.has(clip.id)) {
				context.addIssue({
					code: 'custom',
					message: `Duplicate clip ID '${clip.id}'`,
					path: ['clips', index, 'id']
				});
			}
			ids.add(clip.id);
		}
	});

export const evaluationCorpusManifestV1Schema = z.discriminatedUnion('kind', [
	syntheticConversationRecipeV1Schema,
	archiveTvNewsCorpusV1Schema
]);

export function inspectSyntheticRecipePolicy(recipe: SyntheticConversationRecipeV1): string[] {
	const issues: string[] = [];
	const sourceIdsBySpeaker = new Map<string, Set<string>>();
	const durationBySpeaker = new Map<string, number>();
	for (const speaker of recipe.speakers) {
		sourceIdsBySpeaker.set(speaker.id, new Set());
		durationBySpeaker.set(speaker.id, 0);
	}
	for (const turn of recipe.turns) {
		sourceIdsBySpeaker.get(turn.speakerId)!.add(turn.sourceId);
		durationBySpeaker.set(
			turn.speakerId,
			durationBySpeaker.get(turn.speakerId)! + turn.outputRange.end - turn.outputRange.start
		);
	}
	for (const [speakerId, sourceIds] of sourceIdsBySpeaker) {
		if (sourceIds.size < 2) issues.push(`${speakerId} must use passages from at least two sources`);
	}
	const durations = [...durationBySpeaker.values()];
	if (Math.max(...durations) / Math.min(...durations) > 1.1) {
		issues.push('Speaker output durations must be balanced within 10%');
	}
	const overlaps = buildSyntheticGroundTruth(recipe).overlaps;
	if (!overlaps.some((overlap) => overlap.duration >= 0.5 && overlap.duration <= 1.5)) {
		issues.push('At least one overlap must last between 500 and 1500 ms');
	}
	const turnsById = new Map(recipe.turns.map((turn) => [turn.id, turn]));
	for (const speaker of recipe.speakers) {
		const hasMonologue = recipe.scenarios.some(
			(scenario) =>
				scenario.kind === 'monologue' &&
				scenario.turnIds.some((turnId) => turnsById.get(turnId)?.speakerId === speaker.id)
		);
		if (!hasMonologue) issues.push(`${speaker.id} must have a long-monologue scenario`);
	}
	const handoffGaps = recipe.turns.slice(1).flatMap((turn, index) => {
		const gap = turn.outputRange.start - recipe.turns[index]!.outputRange.end;
		return gap > 0 ? [gap] : [];
	});
	if (handoffGaps.length === 0 || handoffGaps.some((gap) => gap < 0.2 || gap > 0.5)) {
		issues.push('Positive handoff gaps must stay between 200 and 500 ms');
	}
	return issues;
}

export function buildSyntheticGroundTruth(recipe: SyntheticConversationRecipeV1) {
	const overlaps: {
		id: string;
		start: number;
		end: number;
		duration: number;
		speakerIds: string[];
		turnIds: string[];
	}[] = [];
	const groups = new Map<string, SyntheticConversationRecipeV1['turns']>();
	for (const turn of recipe.turns) {
		if (turn.overlapGroup === null) continue;
		const members = groups.get(turn.overlapGroup) ?? [];
		members.push(turn);
		groups.set(turn.overlapGroup, members);
	}
	for (const [id, [left, right]] of groups) {
		if (left === undefined || right === undefined) continue;
		const start = Math.max(left.outputRange.start, right.outputRange.start);
		const end = Math.min(left.outputRange.end, right.outputRange.end);
		overlaps.push({
			id,
			start,
			end,
			duration: end - start,
			speakerIds: [left.speakerId, right.speakerId].sort(),
			turnIds: [left.id, right.id].sort()
		});
	}
	return {
		kind: 'speachy.synthetic-conversation-ground-truth' as const,
		schemaVersion: 1 as const,
		corpusId: recipe.id,
		duration: recipe.render.duration,
		sampleRate: recipe.render.sampleRate,
		annotations: recipe.annotations,
		speakers: recipe.speakers.map(({ id, label }) => ({ id, label })),
		turns: recipe.turns.map(({ id, speakerId, sourceId, sourceRange, outputRange }) => ({
			id,
			speakerId,
			sourceId,
			sourceRange,
			outputRange
		})),
		overlaps
	};
}
