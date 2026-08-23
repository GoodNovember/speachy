# Evaluation corpus contract

This document defines Speachy's path from a controlled public-domain reading to synthetic speaker mixtures and then to real broadcast conversations. It is a design contract, not a claim that any TV News Archive media has been selected, downloaded, licensed, or reviewed.

## Corpus ladder

| Tier | Corpus                           | What it isolates                                                                                                  | What it cannot prove                                                      |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | LibriVox _Dracula_               | Long-form coverage, WER, throughput, memory, and structural timestamps against a curated public-domain reference  | Multiple-speaker behavior, noise robustness, or timestamp accuracy        |
| 2    | Synthetic conversation mixtures  | Exact turn, overlap, transform, and speaker-profile ground truth under deterministic composition                  | Real speaker identity or natural conversational behavior                  |
| 3    | Internet Archive television news | Anchors, correspondents, interviews, remote feeds, interruptions, commercials, noise, and genuine speaker changes | Gold accuracy until captions and speaker boundaries are manually reviewed |

The tiers complement rather than replace one another. A failure in Tier 2 can be reproduced exactly; a failure in Tier 3 tells us whether the controlled result survives real production audio.

## Ownership and storage

Keep four domains separate:

1. **Reviewed recipes and provenance** are checked in. They contain stable identifiers, source URLs, hashes, clip offsets, transforms, and annotation status.
2. **Source media and unreviewed captions** are machine-local and never copied into the repository. Acquisition is explicit and separate from scoring.
3. **Gold annotations** are checked in only when their source and reuse terms permit it. Otherwise they remain in an ignored local corpus bundle keyed by stable clip IDs and hashes.
4. **Rendered mixtures, model output, and benchmark evidence** are rebuildable, ignored artifacts under `web/test-results/`.

Browser permissions, absolute paths, access tokens, retrieval times, model runtime state, and temporary URLs do not belong in reviewed manifests. Runtime evidence may record retrieval time and tool versions because it describes a run rather than corpus identity.

## Shared manifest envelope

Every reviewed corpus recipe begins with a versioned, discriminated envelope:

```json
{
	"kind": "speachy.synthetic-conversation-corpus",
	"schemaVersion": 1,
	"id": "dracula-v3-synthetic-dialogue-01",
	"title": "Dracula synthetic dialogue 01",
	"language": "en",
	"sources": [],
	"scenarios": [],
	"annotations": {
		"transcript": "gold",
		"speakerTurns": "gold"
	}
}
```

Stable IDs use lowercase ASCII letters, digits, and hyphens. Relative paths use forward slashes. Unknown fields, absolute paths, traversal, non-finite times, invalid ranges, and references to unknown source or speaker IDs must fail validation.

## Tier 2: synthetic conversation recipe

Use passages of roughly 10–25 seconds drawn at sentence or paragraph boundaries from multiple chapters. Do not interleave individual words. A pseudo-speaker owns one modest transform profile for the entire corpus, while every profile receives passages from multiple chapters so speaker identity is not confounded with chapter, session, or content.

An initial three-profile design is deliberately conservative:

```json
{
	"speakers": [
		{
			"id": "speaker-a",
			"transform": { "pitchSemitones": 0, "rate": 1, "gainDb": 0 }
		},
		{
			"id": "speaker-b",
			"transform": { "pitchSemitones": 1.5, "rate": 1.06, "gainDb": -1 }
		},
		{
			"id": "speaker-c",
			"transform": { "pitchSemitones": -1.5, "rate": 0.94, "gainDb": -0.5 }
		}
	],
	"turns": [
		{
			"id": "turn-001",
			"speakerId": "speaker-a",
			"sourceId": "dracula-v3-chapter-01",
			"sourceRange": { "start": 30, "end": 48 },
			"outputRange": { "start": 0, "end": 18 },
			"overlapGroup": null
		}
	]
}
```

The real schema must also pin each source audio and transcript hash. Render evidence records the exact ffmpeg build, filter graph, sample rate, channel count, seed, and rendered-audio hash. Transform implementation must preserve the requested rate and pitch independently; changing sample rate alone is not an acceptable pitch shifter.

The first six-minute fixture should contain:

- clean alternating turns;
- 200–500 ms handoffs;
- 500–1,500 ms overlaps;
- at least one long monologue per profile;
- balanced source duration per profile; and
- deterministic collision-free output ordering.

This tier tests stable pseudo-speaker grouping, not real identity recognition. All profiles still originate from one narrator, and transform artifacts may themselves become clustering cues.

## Tier 3: Internet Archive television news

Internet Archive provides [TV news caption search](https://archivesupport.zendesk.com/hc/en-us/articles/360018359991-Search-A-Basic-Guide) and [metadata APIs](https://archivesupport.zendesk.com/hc/en-us/articles/360018538912-Internet-Archive-APIs). Stanford's derived [Cable TV News Dataset](https://tvnews.stanford.edu/data) reports that most of its source videos have accompanying closed captions. Availability does not imply permission to redistribute a broadcast, caption file, or corrected transcript; access and reuse must be reviewed per selected item.

Broadcast captions are **silver annotations**. They can be delayed, shortened, paraphrased, misspelled, or poorly segmented. Markers such as `>>` and displayed names may seed candidate speaker turns but are never accepted as diarization ground truth without review.

A candidate manifest contains non-content metadata only:

```json
{
	"kind": "speachy.archive-tv-news-corpus",
	"schemaVersion": 1,
	"id": "archive-tv-news-conversation-01",
	"language": "en",
	"clips": [
		{
			"id": "clip-001",
			"archiveIdentifier": "identifier-from-archive-org",
			"program": "Program title",
			"channel": "Channel",
			"airDate": "YYYY-MM-DD",
			"sourceRange": { "start": 600, "end": 660 },
			"scenario": "interview",
			"captionStatus": "silver",
			"speakerTurnStatus": "unreviewed"
		}
	]
}
```

The first gold subset is twelve fixed clips of 45–90 seconds:

- four clean anchor or correspondent passages;
- four host/guest interviews; and
- four difficult passages with overlap, interruption, remote audio, or background sound.

Selection balances programs, channels, dates, apparent genders, accents, and acoustic conditions. Commercials and music may appear as explicit stress scenarios but must not accidentally dominate ordinary speech metrics.

The local annotation pack preserves the raw caption stream unchanged and stores manual corrections separately:

- verbatim transcript with non-speech events;
- speaker turns with stable anonymous IDs;
- overlap regions;
- uncertain words and boundaries;
- reviewer status; and
- media, caption, and annotation hashes.

If all models agree on plausible wording that conflicts with the caption, the clip is flagged for reference review rather than counted automatically as a shared model failure.

## Metrics

Every run records model identity, artifact hashes, runtime, decoded audio shape, elapsed time, real-time factor, and memory scope. Quality reporting is additive:

- WER with substitutions, deletions, and insertions;
- speaker-attributed WER and concatenated minimum-permutation WER for mixtures;
- diarization error rate both collar-free and with a declared 250 ms collar;
- Jaccard error rate;
- speaker confusion, missed speech, and false alarm duration;
- overlap precision and recall, reported both included and excluded from DER;
- timestamp coverage and monotonicity; and
- timestamp accuracy only where independently aligned gold timing exists.

Silver-caption scores are labeled separately from gold-reference scores and never compared as if they had equal authority.

## Execution contract

Corpus acquisition, mixture rendering, and scoring are separate commands. Heavy or networked work stays outside normal test discovery and requires an explicit environment gate. Runs are deterministic, bounded, sequential by default, and replayable from a manifest. A scoring command performs no network access and fails clearly when a required local artifact or hash is missing.

Rate-limit Archive.org discovery and acquisition, use an identifying user agent, cache successful responses, and back off on `429` or `503`. Never infer that a viewable or borrowable item is redistributable.

## Next implementation slice

1. Define strict Zod v1 schemas for the shared envelope, synthetic recipe, and TV-news candidate manifest.
2. Add pure validation and timeline tests, including overlap, balance, path, ID, and hash failures.
3. Implement a deterministic two-speaker, six-minute Dracula renderer behind an explicit opt-in gate.
4. Score its transcription against the source text and its speaker timeline against the existing Python diarization baseline.
5. Only then add rate-limited TV-news candidate discovery; selecting and acquiring broadcast clips remains a separate reviewed action.
