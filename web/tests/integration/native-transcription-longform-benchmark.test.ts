import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../../src/lib/server/audio-decode.ts';
import {
	hasSherpaWhisperModel,
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_MODEL_ID
} from '../../src/lib/server/native-whisper.ts';
import { SherpaWhisperTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-transcription.ts';
import type { Audio, TranscriptionRequest } from '../../src/lib/server/executors/types.ts';
import corpusManifest from '../fixtures/longform/dracula-librivox-v3.chapter-01.json';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RUN_LONGFORM = process.env.SPEACHY_RUN_LONGFORM_TRANSCRIPTION_BENCHMARK === '1';
const DEFAULT_OUTPUT = join(WEB_ROOT, 'test-results', 'benchmarks', `${corpusManifest.id}.json`);

async function sha256(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest('hex');
}

async function decodeMp3(filePath: string): Promise<Audio> {
	const bytes = await readFile(filePath);
	const file = Object.assign(new Blob([bytes], { type: 'audio/mpeg' }), {
		name: basename(filePath)
	});
	return decodeAudioUpload(file, { signal: AbortSignal.timeout(300_000) });
}

function transcriptionRequest(audio: Audio): TranscriptionRequest {
	return {
		audio,
		model: SHERPA_WHISPER_MODEL_ID,
		language: corpusManifest.language,
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment'],
		speechSegments: [{ start: 0, end: audio.data.length }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: 30,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		withoutTimestamps: true
	};
}

async function measureNative(audio: Audio) {
	const executor = new SherpaWhisperTranscriptionExecutor();
	const startedAt = new Date();
	const started = performance.now();
	let peakRssBytes = process.memoryUsage().rss;
	const memorySampler = setInterval(() => {
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
	}, 100);
	memorySampler.unref();

	try {
		const result = await executor.transcribe(
			transcriptionRequest(audio),
			AbortSignal.timeout(1_800_000)
		);
		const elapsedMs = performance.now() - started;
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
			wordTimestampCount: result.words?.length ?? 0
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

describe.runIf(RUN_LONGFORM)('native transcription long-form benchmark', () => {
	it('records an opt-in Chapter 1 evidence artifact', async () => {
		const corpusDirectory = process.env.SPEACHY_LONGFORM_CORPUS;
		expect(
			corpusDirectory,
			'SPEACHY_LONGFORM_CORPUS must point to the directory containing the LibriVox MP3s'
		).toBeTruthy();
		const audioPath = resolve(corpusDirectory!, corpusManifest.audioFile);
		expect(existsSync(audioPath), `Long-form audio not found: ${audioPath}`).toBe(true);

		const modelPaths = resolveSherpaWhisperModelPaths();
		expect(
			hasSherpaWhisperModel(modelPaths),
			'The native sherpa Whisper model is not installed'
		).toBe(true);

		const [audioFile, inputSha256, encoder, decoder, tokens] = await Promise.all([
			stat(audioPath),
			sha256(audioPath),
			sha256(modelPaths.encoder),
			sha256(modelPaths.decoder),
			sha256(modelPaths.tokens)
		]);
		const decoded = await decodeMp3(audioPath);
		const durationSeconds = decoded.data.length / decoded.sampleRate;
		const native = await measureNative(decoded);
		const coverage = {
			minimumExpectedWords: corpusManifest.minimumExpectedWords,
			observedWordCount: native.status === 'ok' ? native.wordCount : 0,
			passed: native.status === 'ok' && native.wordCount >= corpusManifest.minimumExpectedWords
		};
		const evidence = {
			schemaVersion: 1,
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
			model: {
				id: SHERPA_WHISPER_MODEL_ID,
				encoder: { fileName: basename(modelPaths.encoder), sha256: encoder },
				decoder: { fileName: basename(modelPaths.decoder), sha256: decoder },
				tokens: { fileName: basename(modelPaths.tokens), sha256: tokens }
			},
			native,
			coverage
		};

		const outputPath = resolve(process.env.SPEACHY_LONGFORM_OUTPUT ?? DEFAULT_OUTPUT);
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
		console.info('SPEACHY_LONGFORM_TRANSCRIPTION_BENCHMARK', outputPath);

		expect(native.status, native.status === 'error' ? native.error : undefined).toBe('ok');
		expect(
			coverage.passed,
			`Transcript contained ${coverage.observedWordCount} words; expected at least ${coverage.minimumExpectedWords} to demonstrate long-form coverage`
		).toBe(true);
	}, 1_900_000);
});
