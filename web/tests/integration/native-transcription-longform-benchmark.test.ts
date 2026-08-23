import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, platform, release, totalmem } from 'node:os';
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
import { PythonTranscriptionExecutor } from '../../src/lib/server/executors/python-transcription.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';
import type {
	Audio,
	TranscriptionExecutor,
	TranscriptionRequest
} from '../../src/lib/server/executors/types.ts';
import corpusManifest from '../fixtures/longform/dracula-librivox-v3.chapter-01.json';
import { normalizeTranscript, scoreTranscript } from '../helpers/transcription-quality.ts';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REFERENCE_PATH = join(
	WEB_ROOT,
	'tests',
	'fixtures',
	'longform',
	corpusManifest.reference.file
);
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const PYTHON_MODEL_ID = 'Systran/faster-whisper-tiny';
const PYTHON_MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--Systran--faster-whisper-tiny'
);
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
	const windowSamples = 29 * audio.sampleRate;
	const speechSegments = [];
	for (let start = 0; start < audio.data.length; start += windowSamples) {
		speechSegments.push({ start, end: Math.min(audio.data.length, start + windowSamples) });
	}
	return {
		audio,
		model,
		language: corpusManifest.language,
		responseFormat: 'verbose_json',
		temperature: 0,
		timestampGranularities: ['segment', 'word'],
		speechSegments,
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

async function measureTranscription(
	audio: Audio,
	model: string,
	executor: TranscriptionExecutor,
	memoryScope: 'node-process' | 'not-measured-python-child-process'
) {
	const startedAt = new Date();
	const started = performance.now();
	let peakRssBytes = memoryScope === 'node-process' ? process.memoryUsage().rss : null;
	const memorySampler =
		memoryScope === 'node-process'
			? setInterval(() => {
					peakRssBytes = Math.max(peakRssBytes!, process.memoryUsage().rss);
				}, 100)
			: undefined;
	memorySampler?.unref();

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
			memoryScope,
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
			memoryScope,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		};
	} finally {
		if (memorySampler !== undefined) clearInterval(memorySampler);
	}
}

type MeasuredResult = Awaited<ReturnType<typeof measureTranscription>>;

function withQuality(result: MeasuredResult, reference: string) {
	return {
		...result,
		quality: result.status === 'ok' ? scoreTranscript(reference, result.text) : null
	};
}

function coverage(result: ReturnType<typeof withQuality>) {
	return {
		minimumExpectedWords: corpusManifest.minimumExpectedWords,
		observedWordCount: result.status === 'ok' ? result.wordCount : 0,
		passed: result.status === 'ok' && result.wordCount >= corpusManifest.minimumExpectedWords
	};
}

function benchmarkSummary(
	title: string,
	results: Record<string, ReturnType<typeof withQuality>>
): string {
	const lines = [
		`# ${title}`,
		'',
		'| Backend | WER | Errors (S/D/I) | RTF | Peak RSS | Word spans |',
		'| --- | ---: | ---: | ---: | ---: | ---: |'
	];
	for (const [name, result] of Object.entries(results)) {
		if (result.status !== 'ok' || result.quality === null) {
			lines.push(`| ${name} | error | — | — | — | — |`);
			continue;
		}
		const quality = result.quality;
		const memory =
			result.peakRssBytes === null
				? 'not measured'
				: `${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB`;
		lines.push(
			`| ${name} | ${(quality.wordErrorRate * 100).toFixed(2)}% | ${quality.errorCount} (${quality.substitutions}/${quality.deletions}/${quality.insertions}) | ${result.realTimeFactor.toFixed(3)} | ${memory} | ${result.wordTimestampCount} |`
		);
	}
	lines.push(
		'',
		'Normalization folds Unicode, case, apostrophes, and punctuation. Lexical and numeric-format differences still count.',
		'Python peak RSS is not reported because Node cannot observe the inference worker child process portably.',
		'Word-span counts establish structural coverage only; timestamp accuracy requires independently aligned ground truth.',
		''
	);
	return lines.join('\n');
}

describe.runIf(RUN_LONGFORM)('transcription long-form quality benchmark', () => {
	it('records opt-in Python, Whisper, and Parakeet Chapter 1 evidence', async () => {
		const corpusDirectory = process.env.SPEACHY_LONGFORM_CORPUS;
		expect(
			corpusDirectory,
			'SPEACHY_LONGFORM_CORPUS must point to the directory containing the LibriVox MP3s'
		).toBeTruthy();
		const audioPath = resolve(corpusDirectory!, corpusManifest.audioFile);
		expect(existsSync(audioPath), `Long-form audio not found: ${audioPath}`).toBe(true);
		expect(existsSync(PYTHON), `Python baseline runtime not found: ${PYTHON}`).toBe(true);
		expect(
			existsSync(PYTHON_MODEL_CACHE),
			`Python baseline model not found: ${PYTHON_MODEL_CACHE}`
		).toBe(true);

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
		const [inputSha256, referenceFileText, pythonRevision, whisperModel, parakeetModel] =
			await Promise.all([
				sha256(audioPath),
				readFile(REFERENCE_PATH, 'utf8'),
				readFile(join(PYTHON_MODEL_CACHE, 'refs', 'main'), 'utf8').then((value) => value.trim()),
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
		const referenceText = referenceFileText.replace(/\r\n?/gu, '\n');
		const referenceSha256 = createHash('sha256').update(referenceText).digest('hex');
		const decoded = await decodeMp3(audioPath);
		expect(referenceSha256, 'The checked-in reference changed without a manifest update').toBe(
			corpusManifest.reference.sha256
		);
		const durationSeconds = decoded.data.length / decoded.sampleRate;
		const pythonWorker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HF_HUB_OFFLINE: '1',
				WHISPER__INFERENCE_DEVICE: 'cpu',
				WHISPER__COMPUTE_TYPE: 'int8',
				WHISPER__CPU_THREADS: '2',
				WHISPER__NUM_WORKERS: '1'
			},
			name: 'longform-quality-python'
		});
		let python: MeasuredResult;
		try {
			await pythonWorker.ping();
			python = await measureTranscription(
				decoded,
				PYTHON_MODEL_ID,
				new PythonTranscriptionExecutor(pythonWorker),
				'not-measured-python-child-process'
			);
		} finally {
			await pythonWorker.close();
		}
		const whisperExecutor = new SherpaWhisperTranscriptionExecutor();
		let whisper: MeasuredResult;
		try {
			whisper = await measureTranscription(
				decoded,
				SHERPA_WHISPER_MODEL_ID,
				whisperExecutor,
				'node-process'
			);
		} finally {
			await whisperExecutor.close();
		}
		const parakeetExecutor = new SherpaParakeetTranscriptionExecutor();
		let parakeet: MeasuredResult;
		try {
			parakeet = await measureTranscription(
				decoded,
				SHERPA_PARAKEET_MODEL_ID,
				parakeetExecutor,
				'node-process'
			);
		} finally {
			await parakeetExecutor.close();
		}
		const results = {
			python: withQuality(python, referenceText),
			whisper: withQuality(whisper, referenceText),
			parakeet: withQuality(parakeet, referenceText)
		};
		const evidence = {
			schemaVersion: 3,
			benchmark: 'speachy.transcription.longform-quality',
			corpus: corpusManifest,
			reference: {
				fileName: corpusManifest.reference.file,
				byteLength: Buffer.byteLength(referenceText),
				sha256: referenceSha256,
				normalizedWordCount: normalizeTranscript(referenceText).length,
				normalization: 'unicode-case-apostrophe-punctuation-v1'
			},
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
				python: { id: PYTHON_MODEL_ID, huggingFaceRevision: pythonRevision },
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
			results,
			coverage: {
				python: coverage(results.python),
				whisper: coverage(results.whisper),
				parakeet: coverage(results.parakeet)
			}
		};

		const outputPath = resolve(process.env.SPEACHY_LONGFORM_OUTPUT ?? DEFAULT_OUTPUT);
		const summaryPath = outputPath.replace(/\.json$/u, '.summary.md');
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
		await writeFile(summaryPath, benchmarkSummary(corpusManifest.title, results), 'utf8');
		console.info('SPEACHY_LONGFORM_TRANSCRIPTION_BENCHMARK', outputPath, summaryPath);

		for (const [name, result] of Object.entries(evidence.results)) {
			expect(result.status, result.status === 'error' ? result.error : undefined).toBe('ok');
			const resultCoverage = evidence.coverage[name as keyof typeof evidence.coverage];
			expect(
				resultCoverage.passed,
				`${name} contained ${resultCoverage.observedWordCount} words; expected at least ${resultCoverage.minimumExpectedWords}`
			).toBe(true);
			expect(result.quality?.referenceWordCount).toBeGreaterThan(5_000);
		}
	}, 5_500_000);
});
