import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../../src/lib/server/audio-decode.ts';
import {
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_MODEL_ID
} from '../../src/lib/server/native-diarization.ts';
import { PythonDiarizationExecutor } from '../../src/lib/server/executors/python-diarization.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';
import { SherpaDiarizationExecutor } from '../../src/lib/server/executors/sherpa-diarization.ts';
import type {
	Audio,
	DiarizationExecutor,
	DiarizationSegment
} from '../../src/lib/server/executors/types.ts';
import recipeJson from '../fixtures/evaluation/dracula-v3-synthetic-dialogue-01.json';
import { scoreDiarization } from '../helpers/diarization-quality.ts';
import { syntheticConversationRecipeV1Schema } from '../helpers/evaluation-corpus.ts';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const RECIPE_PATH = fileURLToPath(
	new URL('../fixtures/evaluation/dracula-v3-synthetic-dialogue-01.json', import.meta.url)
);
const recipe = syntheticConversationRecipeV1Schema.parse(recipeJson);
const SYNTHETIC_DIRECTORY = join(WEB_ROOT, 'test-results', 'synthetic', recipe.id);
const AUDIO_PATH = join(SYNTHETIC_DIRECTORY, `${recipe.id}.wav`);
const GROUND_TRUTH_PATH = join(SYNTHETIC_DIRECTORY, `${recipe.id}.ground-truth.json`);
const EXPECTED_AUDIO_SHA256 = '3700347d8bf0d203077565b15115f8d55f5be921a463085a58883e0e688ae690';
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const PYTHON_MODEL_ID = 'pyannote/speaker-diarization-community-1';
const PYTHON_MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--pyannote--speaker-diarization-community-1'
);
const nativePaths = resolveSherpaDiarizationModelPaths();
const RUN_BENCHMARK =
	process.env.SPEACHY_RUN_DIARIZATION_BENCHMARK === '1' &&
	existsSync(AUDIO_PATH) &&
	existsSync(GROUND_TRUTH_PATH) &&
	existsSync(PYTHON) &&
	existsSync(PYTHON_MODEL_CACHE) &&
	existsSync(nativePaths.segmentation) &&
	existsSync(nativePaths.embedding);
const TIMEOUT_MS = Number(process.env.SPEACHY_DIARIZATION_BENCHMARK_TIMEOUT_MS ?? 1_800_000);
const OUTPUT_PATH =
	process.env.SPEACHY_DIARIZATION_BENCHMARK_OUTPUT ??
	join(WEB_ROOT, 'test-results', 'benchmarks', `${recipe.id}.diarization.json`);

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest('hex');
}

async function fileEvidence(filePath: string) {
	const info = await stat(filePath);
	return {
		fileName: basename(filePath),
		byteLength: info.size,
		sha256: await sha256File(filePath)
	};
}

async function decodeWav(filePath: string): Promise<Audio> {
	const bytes = await readFile(filePath);
	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);
	const file = Object.assign(new Blob([body], { type: 'audio/wav' }), {
		name: basename(filePath)
	});
	return decodeAudioUpload(file);
}

function projectToDuration(segments: readonly DiarizationSegment[], duration: number) {
	let clippedSegmentCount = 0;
	let droppedSegmentCount = 0;
	const projected = segments.flatMap((segment) => {
		const start = Math.max(0, segment.start);
		const end = Math.min(duration, segment.end);
		if (end <= start) {
			droppedSegmentCount += 1;
			return [];
		}
		if (start !== segment.start || end !== segment.end) clippedSegmentCount += 1;
		return [{ ...segment, start, end }];
	});
	return { segments: projected, clippedSegmentCount, droppedSegmentCount };
}

const scoreVariants = {
	collarFreeOverlapIncluded: { collarSeconds: 0, skipOverlap: false },
	boundaryToleranceOverlapIncluded: { collarSeconds: 0.5, skipOverlap: false },
	collarFreeOverlapExcluded: { collarSeconds: 0, skipOverlap: true },
	boundaryToleranceOverlapExcluded: { collarSeconds: 0.5, skipOverlap: true }
} as const;

async function measure(
	executor: DiarizationExecutor,
	modelId: string,
	audio: Audio,
	memoryScope: 'node-process' | 'not-measured-python-child-process'
) {
	const startedAt = new Date();
	const started = performance.now();
	let peakRssBytes = memoryScope === 'node-process' ? process.memoryUsage().rss : null;
	const sampler =
		memoryScope === 'node-process'
			? setInterval(() => {
					peakRssBytes = Math.max(peakRssBytes!, process.memoryUsage().rss);
				}, 100)
			: undefined;
	sampler?.unref();
	try {
		const segments = await executor.diarize(
			{ audio, modelId, numSpeakers: 2 },
			AbortSignal.timeout(TIMEOUT_MS)
		);
		const elapsedMs = performance.now() - started;
		return {
			status: 'ok' as const,
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			elapsedMs,
			realTimeFactor: elapsedMs / 1_000 / (audio.data.length / audio.sampleRate),
			peakRssBytes,
			memoryScope,
			segments
		};
	} catch (error) {
		return {
			status: 'error' as const,
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			elapsedMs: performance.now() - started,
			peakRssBytes,
			memoryScope,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		};
	} finally {
		if (sampler !== undefined) clearInterval(sampler);
	}
}

type Measurement = Awaited<ReturnType<typeof measure>>;

function withScores(
	measurement: Measurement,
	reference: readonly DiarizationSegment[],
	duration: number
) {
	if (measurement.status !== 'ok') return { ...measurement, projection: null, scores: null };
	const projection = projectToDuration(measurement.segments, duration);
	return {
		...measurement,
		projection: {
			clippedSegmentCount: projection.clippedSegmentCount,
			droppedSegmentCount: projection.droppedSegmentCount
		},
		scores: Object.fromEntries(
			Object.entries(scoreVariants).map(([name, variant]) => [
				name,
				scoreDiarization(reference, projection.segments, { duration, ...variant })
			])
		)
	};
}

function summary(results: Record<string, ReturnType<typeof withScores>>): string {
	const lines = [
		`# ${recipe.title} diarization comparison`,
		'',
		'Both backends received the fixed speaker count of two. DER uses optimal anonymous-speaker mapping.',
		'The boundary-tolerance variant uses a 0.5 second centered collar: 250 ms on each side of every gold boundary.',
		'',
		'| Backend | DER 0 ms + overlap | DER ±250 ms + overlap | DER 0 ms no overlap | DER ±250 ms no overlap | JER 0 ms + overlap | Overlap P/R | RTF |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
	];
	for (const [name, result] of Object.entries(results)) {
		if (result.status !== 'ok' || result.scores === null) {
			lines.push(`| ${name} | error | — | — | — | — | — | — |`);
			continue;
		}
		const free = result.scores.collarFreeOverlapIncluded;
		const collar = result.scores.boundaryToleranceOverlapIncluded;
		const freeNoOverlap = result.scores.collarFreeOverlapExcluded;
		const collarNoOverlap = result.scores.boundaryToleranceOverlapExcluded;
		lines.push(
			`| ${name} | ${(free.diarizationErrorRate * 100).toFixed(2)}% | ${(collar.diarizationErrorRate * 100).toFixed(2)}% | ${(freeNoOverlap.diarizationErrorRate * 100).toFixed(2)}% | ${(collarNoOverlap.diarizationErrorRate * 100).toFixed(2)}% | ${(free.jaccardErrorRate * 100).toFixed(2)}% | ${(free.overlap.precision * 100).toFixed(1)}% / ${(free.overlap.recall * 100).toFixed(1)}% | ${result.realTimeFactor.toFixed(3)} |`
		);
	}
	lines.push(
		'',
		'This synthetic corpus isolates reproducible grouping and boundary behavior. Both pseudo-speakers originate from one narrator and transforms can become artificial clustering cues.',
		''
	);
	return lines.join('\n');
}

describe.runIf(RUN_BENCHMARK)('diarization quality benchmark', () => {
	it(
		'scores native sherpa and Community-1 against the same gold timeline',
		async () => {
			expect(await sha256File(AUDIO_PATH), 'The rendered fixture changed').toBe(
				EXPECTED_AUDIO_SHA256
			);
			const audio = await decodeWav(AUDIO_PATH);
			const duration = audio.data.length / audio.sampleRate;
			expect(duration).toBe(recipe.render.duration);
			const reference = recipe.turns.map((turn) => ({
				start: turn.outputRange.start,
				end: turn.outputRange.end,
				speaker: turn.speakerId
			}));

			const nativeExecutor = new SherpaDiarizationExecutor();
			let nativeMeasurement: Measurement;
			try {
				nativeMeasurement = await measure(
					nativeExecutor,
					SHERPA_DIARIZATION_MODEL_ID,
					audio,
					'node-process'
				);
			} finally {
				await nativeExecutor.close();
			}

			const worker = new PythonWorkerClient({
				command: PYTHON,
				args: ['-m', 'speaches.inference_worker'],
				cwd: REPO_ROOT,
				env: { ...process.env, HF_HUB_OFFLINE: '1' },
				name: 'python-diarization-benchmark'
			});
			let pythonMeasurement: Measurement;
			try {
				await worker.ping();
				pythonMeasurement = await measure(
					new PythonDiarizationExecutor(worker),
					PYTHON_MODEL_ID,
					audio,
					'not-measured-python-child-process'
				);
			} finally {
				await worker.close();
			}

			const results = {
				nativeSherpa: withScores(nativeMeasurement, reference, duration),
				pythonCommunity1: withScores(pythonMeasurement, reference, duration)
			};
			const evidence = {
				kind: 'speachy.diarization-quality-benchmark',
				schemaVersion: 1,
				corpus: {
					id: recipe.id,
					recipe: await fileEvidence(RECIPE_PATH),
					audio: await fileEvidence(AUDIO_PATH),
					groundTruth: await fileEvidence(GROUND_TRUTH_PATH),
					annotationStatus: recipe.annotations
				},
				protocol: {
					numSpeakers: 2,
					mapping: 'optimal-one-to-one',
					variants: scoreVariants,
					collarInterpretation: '0.5 seconds centered, 0.25 seconds on each side',
					overlapMetrics: 'duration precision and recall on the full evaluation map'
				},
				models: {
					nativeSherpa: {
						id: SHERPA_DIARIZATION_MODEL_ID,
						segmentation: await fileEvidence(nativePaths.segmentation),
						embedding: await fileEvidence(nativePaths.embedding)
					},
					pythonCommunity1: { id: PYTHON_MODEL_ID, cachePresent: true }
				},
				results
			};
			await mkdir(dirname(OUTPUT_PATH), { recursive: true });
			await Promise.all([
				writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`),
				writeFile(OUTPUT_PATH.replace(/\.json$/, '.summary.md'), summary(results))
			]);
			expect(results.nativeSherpa.status).toBe('ok');
			expect(results.pythonCommunity1.status).toBe('ok');
			expect(
				results.nativeSherpa.scores?.collarFreeOverlapIncluded.diarizationErrorRate
			).toBeGreaterThanOrEqual(0);
			expect(
				results.pythonCommunity1.scores?.collarFreeOverlapIncluded.diarizationErrorRate
			).toBeGreaterThanOrEqual(0);
		},
		TIMEOUT_MS * 2 + 60_000
	);
});
