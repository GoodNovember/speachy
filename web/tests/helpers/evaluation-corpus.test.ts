import { describe, expect, it } from 'vitest';
import recipeJson from '../fixtures/evaluation/dracula-v3-synthetic-dialogue-01.json';
import {
	archiveTvNewsCorpusV1Schema,
	buildSyntheticGroundTruth,
	evaluationCorpusManifestV1Schema,
	inspectSyntheticRecipePolicy,
	syntheticConversationRecipeV1Schema
} from './evaluation-corpus.ts';

function recipeCopy(): Record<string, unknown> {
	return structuredClone(recipeJson) as Record<string, unknown>;
}

describe('evaluation corpus v1 schemas', () => {
	it('accepts the reviewed synthetic recipe with balanced, cross-chapter speakers', () => {
		const recipe = syntheticConversationRecipeV1Schema.parse(recipeJson);
		expect(inspectSyntheticRecipePolicy(recipe)).toEqual([]);
		expect(recipe.turns).toHaveLength(18);
		expect(new Set(recipe.turns.map((turn) => turn.sourceId)).size).toBe(4);
	});

	it('rejects unknown fields, unsafe paths, and malformed hashes', () => {
		const unknown = recipeCopy();
		unknown.volatileRuntimePath = 'D:/private/audio';
		expect(syntheticConversationRecipeV1Schema.safeParse(unknown).success).toBe(false);

		const unsafePath = recipeCopy();
		(unsafePath.sources as { audioFile: string }[])[0]!.audioFile = '../chapter.mp3';
		expect(syntheticConversationRecipeV1Schema.safeParse(unsafePath).success).toBe(false);

		const malformedHash = recipeCopy();
		(malformedHash.sources as { audioSha256: string }[])[0]!.audioSha256 = 'abc';
		expect(syntheticConversationRecipeV1Schema.safeParse(malformedHash).success).toBe(false);
	});

	it('rejects dangling references and transform-inconsistent timelines', () => {
		const dangling = recipeCopy();
		(dangling.turns as { sourceId: string }[])[0]!.sourceId = 'missing-source';
		expect(syntheticConversationRecipeV1Schema.safeParse(dangling).success).toBe(false);

		const wrongDuration = recipeCopy();
		(
			wrongDuration.turns as { outputRange: { start: number; end: number } }[]
		)[1]!.outputRange.end += 1;
		expect(syntheticConversationRecipeV1Schema.safeParse(wrongDuration).success).toBe(false);
	});

	it('derives exact turn and overlap ground truth without changing the recipe', () => {
		const recipe = syntheticConversationRecipeV1Schema.parse(recipeJson);
		const before = JSON.stringify(recipe);
		const truth = buildSyntheticGroundTruth(recipe);
		expect(JSON.stringify(recipe)).toBe(before);
		expect(truth.duration).toBe(360);
		expect(truth.turns).toHaveLength(18);
		expect(truth.turns.at(-1)?.outputRange.end).toBe(360);
		expect(truth.overlaps).toHaveLength(9);
		expect(truth.overlaps[0]).toMatchObject({
			id: 'overlap-01',
			start: 22.318,
			end: 23.518,
			speakerIds: ['speaker-a', 'speaker-b']
		});
		expect(
			truth.overlaps.every((overlap) => overlap.duration >= 0.5 && overlap.duration <= 1.5)
		).toBe(true);
	});

	it('keeps TV-news candidates metadata-only and strict', () => {
		const candidate = {
			kind: 'speachy.archive-tv-news-corpus',
			schemaVersion: 1,
			id: 'archive-tv-news-conversation-01',
			title: 'TV news candidates 01',
			language: 'en',
			annotations: { transcript: 'silver', speakerTurns: 'unreviewed' },
			clips: [
				{
					id: 'clip-001',
					archiveIdentifier: 'sample-item',
					program: 'Sample program',
					channel: 'Sample channel',
					airDate: '2020-01-02',
					sourceRange: { start: 600, end: 660 },
					scenario: 'interview',
					captionStatus: 'silver',
					speakerTurnStatus: 'unreviewed'
				}
			]
		};
		expect(archiveTvNewsCorpusV1Schema.safeParse(candidate).success).toBe(true);
		expect(evaluationCorpusManifestV1Schema.safeParse(candidate).success).toBe(true);
		expect(evaluationCorpusManifestV1Schema.safeParse(recipeJson).success).toBe(true);
		expect(
			archiveTvNewsCorpusV1Schema.safeParse({ ...candidate, mediaUrl: 'https://example.com' })
				.success
		).toBe(false);
	});
});
