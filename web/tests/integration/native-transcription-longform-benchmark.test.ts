import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../../src/lib/server/audio-decode.ts';
import {
	hasSherpaParakeetModel,
	resolveSherpaParakeetModelPaths,
	SHERPA_PARAKEET_MODEL_ID
} from '../../src/lib/server/native-parakeet.ts';
import {
	hasSherpaWhisperModel,
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_MODEL_ID
} from '../../src/lib/server/native-whisper.ts';
import { SherpaParakeetTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-parakeet-transcription.ts';
import { SherpaWhisperTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-transcription.ts';
import type {
	Audio,
	TranscriptionExecutor,
	TranscriptionRequest
} from '../../src/lib/server/executors/types.ts';
import corpusManifest from '../fixtures/longform/dracula-librivox-v3.chapter-01.json';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUN_LONGFORM = process.env.SPEACHY_RUN_LONGFORM_TRANSCRIPTION_BENCHMARK === '1';
const DEFAULT_OUTPUT = join(WEB_ROOT, 'test-results', 'benchmarks', `${corpusManifest.id}.json`);

async function sha256(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest('hex');
}

async function modelFile(filePath: string) {
	const file = await stat(filePath);
	return { fileName: basename(filePath), byteLength: file.size, sha256: await sha256(filePath) };
}

async function decodeMp3(filePath: string): Promise<Audio> {
	const bytes = await readFile(filePath);
	const file = Object.assign(new Blob([bytes], { type: 'audio/mpeg' }), {
		name: basename(filePath)
	});
	return decodeAudioUpload(file, { signal: AbortSignal.timeout(300_000) });
}

function transcriptionRequest(audio: Audio, model: string): TranscriptionRequest {
	return {
		audio,
		model,
		language: corpusManifest.language,
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment', 'word'],
		speechSegments: [{ start: 0, end: audio.data.length }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: 30,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		withoutTimestamps: false
	};
}

async function measureNative(
	audio: Audio,
	model: string,
	executor: TranscriptionExecutor & { close(): Promise<void> }
) {
	const startedAt = new Date();
	const started = performance.now();
	let peakRssBytes = process.memoryUsage().rss;
	const memorySampler = setInterval(() => {
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
	}, 100);
	memorySampler.unref();

	try {
		const result = await executor.transcribe(
			transcriptionRequest(audio, model),
			AbortSignal.timeout(1_800_000)
		);
		const elapsedMs = performance.now() - started;
		const words = result.words ?? [];
		const wordTimestampsMonotonic = words.every(
			(word, index) =>
				Number.isFinite(word.start) &&
				Number.isFinite(word.end) &&
				word.start <= word.end &&
				(index === 0 || words[index - 1]!.start <= word.start)
		);
		return {
			status: 'ok' as const,
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			elapsedMs,
			realTimeFactor: elapsedMs / 1_000 / (audio.data.length / audio.sampleRate),
			peakRssBytes,
			text: result.text,
			textSha256: createHash('sha256').update(result.text).digest('hex'),
			characterCount: result.text.length,
			wordCount: result.text.trim() === '' ? 0 : result.text.trim().split(/\s+/).length,
			segmentCount: result.segments?.length ?? 0,
			wordTimestampCount: words.length,
			wordTimestampsMonotonic,
			wordTimestampRange:
				words.length === 0 ? null : { start: words[0]!.start, end: words.at(-1)!.end }
		};
	} catch (error) {
		return {
			status: 'error' as const,
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			elapsedMs: performance.now() - started,
			peakRssBytes,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		};
	} finally {
		clearInterval(memorySampler);
		await executor.close();
	}
}

function coverage(result: Awaited<ReturnType<typeof measureNative>>) {
	return {
		minimumExpectedWords: corpusManifest.minimumExpectedWords,
		observedWordCount: result.status === 'ok' ? result.wordCount : 0,
		passed: result.status === 'ok' && result.wordCount >= corpusManifest.minimumExpectedWords
	};
}

describe.runIf(RUN_LONGFORM)('native transcription long-form benchmark', () => {
	it('records opt-in Whisper and Parakeet Chapter 1 evidence', async () => {
		const corpusDirectory = process.env.SPEACHY_LONGFORM_CORPUS;
		expect(
			corpusDirectory,
			'SPEACHY_LONGFORM_CORPUS must point to the directory containing the LibriVox MP3s'
		).toBeTruthy();
		const audioPath = resolve(corpusDirectory!, corpusManifest.audioFile);
		expect(existsSync(audioPath), `Long-form audio not found: ${audioPath}`).toBe(true);

		const whisperPaths = resolveSherpaWhisperModelPaths();
		const parakeetPaths = resolveSherpaParakeetModelPaths();
		expect(hasSherpaWhisperModel(whisperPaths), 'The native Whisper model is not installed').toBe(
			true
		);
		expect(
			hasSherpaParakeetModel(parakeetPaths),
			'The native Parakeet model is not installed'
		).toBe(true);

		const audioFile = await stat(audioPath);
		const [inputSha256, whisperModel, parakeetModel] = await Promise.all([
			sha256(audioPath),
			Promise.all([
				modelFile(whisperPaths.encoder),
				modelFile(whisperPaths.decoder),
				modelFile(whisperPaths.tokens)
			]),
			Promise.all([
				modelFile(parakeetPaths.encoder),
				modelFile(parakeetPaths.decoder),
				modelFile(parakeetPaths.joiner),
				modelFile(parakeetPaths.tokens)
			])
		]);
		const decoded = await decodeMp3(audioPath);
		const durationSeconds = decoded.data.length / decoded.sampleRate;
		const whisper = await measureNative(
			decoded,
			SHERPA_WHISPER_MODEL_ID,
			new SherpaWhisperTranscriptionExecutor()
		);
		const parakeet = await measureNative(
			decoded,
			SHERPA_PARAKEET_MODEL_ID,
			new SherpaParakeetTranscriptionExecutor()
		);
		const evidence = {
			schemaVersion: 2,
			benchmark: 'speachy.native-transcription.longform',
			corpus: corpusManifest,
			input: {
				fileName: corpusManifest.audioFile,
				byteLength: audioFile.size,
				sha256: inputSha256,
				decodedSampleRate: decoded.sampleRate,
				decodedSampleCount: decoded.data.length,
				durationSeconds
			},
			runtime: {
				platform: platform(),
				arch: arch(),
				release: release(),
				node: process.version,
				cpu: cpus()[0]?.model ?? 'unknown',
				logicalCpuCount: cpus().length,
				totalMemoryBytes: totalmem()
			},
			models: {
				whisper: {
					id: SHERPA_WHISPER_MODEL_ID,
					encoder: whisperModel[0],
					decoder: whisperModel[1],
					tokens: whisperModel[2]
				},
				parakeet: {
					id: SHERPA_PARAKEET_MODEL_ID,
					encoder: parakeetModel[0],
					decoder: parakeetModel[1],
					joiner: parakeetModel[2],
					tokens: parakeetModel[3]
				}
			},
			results: { whisper, parakeet },
			coverage: { whisper: coverage(whisper), parakeet: coverage(parakeet) }
		};

		const outputPath = resolve(process.env.SPEACHY_LONGFORM_OUTPUT ?? DEFAULT_OUTPUT);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
		console.info('SPEACHY_LONGFORM_TRANSCRIPTION_BENCHMARK', outputPath);

		for (const [name, result] of Object.entries(evidence.results)) {
			expect(result.status, result.status === 'error' ? result.error : undefined).toBe('ok');
			const resultCoverage = evidence.coverage[name as keyof typeof evidence.coverage];
			expect(
				resultCoverage.passed,
				`${name} contained ${resultCoverage.observedWordCount} words; expected at least ${resultCoverage.minimumExpectedWords}`
			).toBe(true);
		}
	}, 3_700_000);
});
