import { createRequire } from 'node:module';
import {
	hasSherpaParakeetModel,
	resolveSherpaParakeetModelPaths,
	SHERPA_PARAKEET_MODEL_ID,
	sherpaParakeetCreatedAt,
	type SherpaParakeetModelPaths
} from '../native-parakeet.ts';
import type {
	Model,
	Transcription,
	TranscriptionEvent,
	TranscriptionExecutor,
	TranscriptionRequest,
	TranscriptionWord
} from './types.ts';
import { WorkerPool } from './worker-pool.ts';
import sherpaWorkerSource from './sherpa-transcription-worker.cjs?raw';

type NativeRecognitionResult = {
	text: string;
	lang?: string;
	tokens?: string[];
	timestamps?: number[];
	durations?: number[];
};

type NativeTranscriptionClient = {
	call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
	close?(): Promise<void>;
};

export type SherpaParakeetExecutorOptions = {
	paths?: SherpaParakeetModelPaths;
	client?: NativeTranscriptionClient;
	workerCount?: number;
	modelThreads?: number;
};

const MAX_CONTROLLED_CHUNK_SECONDS = 29;

function validateRequest(request: TranscriptionRequest): void {
	if (request.model !== SHERPA_PARAKEET_MODEL_ID) {
		throw new Error(`Only '${SHERPA_PARAKEET_MODEL_ID}' is supported`);
	}
	if (request.language !== undefined && !/^en(?:-|$)/i.test(request.language)) {
		throw new Error('The native Parakeet v2 model only supports English');
	}
	if (request.temperature !== 0) {
		throw new Error('The native Parakeet executor currently requires temperature 0');
	}
	if (request.prompt !== undefined || request.hotwords !== undefined) {
		throw new Error('The native Parakeet executor does not yet support prompts or hotwords');
	}
}

function decodeResult(value: unknown): NativeRecognitionResult {
	if (
		typeof value !== 'object' ||
		value === null ||
		typeof (value as { text?: unknown }).text !== 'string'
	) {
		throw new Error('Sherpa returned an invalid Parakeet transcription result');
	}
	return value as NativeRecognitionResult;
}

function chunkSpeechSegments(
	segments: TranscriptionRequest['speechSegments'],
	sampleCount: number,
	sampleRate: number
): { start: number; end: number }[] {
	const maxSamples = Math.max(1, Math.floor(MAX_CONTROLLED_CHUNK_SECONDS * sampleRate));
	const chunks: { start: number; end: number }[] = [];
	for (const segment of segments) {
		const start = Math.max(0, Math.min(sampleCount, Math.trunc(segment.start)));
		const end = Math.max(start, Math.min(sampleCount, Math.trunc(segment.end)));
		for (let offset = start; offset < end; offset += maxSamples) {
			chunks.push({ start: offset, end: Math.min(offset + maxSamples, end) });
		}
	}
	return chunks;
}

export function mapParakeetWordTimestamps(
	result: NativeRecognitionResult,
	chunkStartSeconds: number,
	chunkEndSeconds: number
): TranscriptionWord[] | undefined {
	if (
		result.tokens === undefined ||
		result.timestamps === undefined ||
		result.tokens.length === 0 ||
		result.tokens.length !== result.timestamps.length
	) {
		return result.text.trim() === '' ? [] : undefined;
	}
	const chunkDuration = chunkEndSeconds - chunkStartSeconds;
	let previous = 0;
	const starts: number[] = [];
	for (const timestamp of result.timestamps) {
		if (!Number.isFinite(timestamp) || timestamp < previous || timestamp < 0) return undefined;
		previous = timestamp;
		starts.push(chunkStartSeconds + Math.min(timestamp, chunkDuration));
	}

	const words: TranscriptionWord[] = [];
	let word = '';
	let wordStart = chunkStartSeconds;
	const flush = (end: number): void => {
		if (word === '') return;
		words.push({
			word,
			start: wordStart,
			end: Math.max(wordStart, Math.min(end, chunkEndSeconds))
		});
		word = '';
	};

	for (let index = 0; index < result.tokens.length; index += 1) {
		const normalized = result.tokens[index]!.replaceAll('▁', ' ');
		const beginsWord = /^\s/u.test(normalized);
		const token = normalized.trimStart();
		const tokenStart = starts[index]!;
		if (beginsWord) flush(tokenStart);
		if (token === '') continue;
		if (word === '') wordStart = tokenStart;
		word += token;
	}
	flush(chunkEndSeconds);
	return words;
}

export class SherpaParakeetTranscriptionExecutor implements TranscriptionExecutor {
	readonly name = 'sherpa-parakeet-native';
	readonly task = 'automatic-speech-recognition' as const;

	readonly #paths: SherpaParakeetModelPaths;
	readonly #client: NativeTranscriptionClient;

	constructor(options: SherpaParakeetExecutorOptions = {}) {
		this.#paths = options.paths ?? resolveSherpaParakeetModelPaths();
		this.#client =
			options.client ??
			new WorkerPool({
				script: sherpaWorkerSource,
				eval: true,
				size: options.workerCount ?? 1,
				workerData: {
					model: {
						kind: 'nemo_transducer',
						encoder: this.#paths.encoder,
						decoder: this.#paths.decoder,
						joiner: this.#paths.joiner,
						tokens: this.#paths.tokens
					},
					numThreads: options.modelThreads ?? 2,
					modulePath: createRequire(import.meta.url).resolve('sherpa-onnx-node')
				},
				name: 'sherpa-parakeet'
			});
	}

	async listLocalModels(): Promise<Model[]> {
		if (!hasSherpaParakeetModel(this.#paths)) return [];
		return [
			{
				id: SHERPA_PARAKEET_MODEL_ID,
				created: await sherpaParakeetCreatedAt(this.#paths),
				ownedBy: 'sherpa-onnx',
				task: this.task,
				language: ['en']
			}
		];
	}

	async listRemoteModels(): Promise<Model[]> {
		return [];
	}

	async canHandle(modelId: string): Promise<boolean> {
		return modelId === SHERPA_PARAKEET_MODEL_ID && hasSherpaParakeetModel(this.#paths);
	}

	async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcription> {
		validateRequest(request);
		if (!hasSherpaParakeetModel(this.#paths)) {
			throw new Error(`Native model '${SHERPA_PARAKEET_MODEL_ID}' is not installed`);
		}
		const duration = request.audio.data.length / request.audio.sampleRate;
		const chunks = chunkSpeechSegments(
			request.speechSegments,
			request.audio.data.length,
			request.audio.sampleRate
		);
		const texts: string[] = [];
		const segments: NonNullable<Transcription['segments']> = [];
		const words: TranscriptionWord[] = [];
		let wordsAvailable = request.timestampGranularities.includes('word');
		for (const chunk of chunks) {
			if (signal.aborted) throw signal.reason;
			const value = await this.#client.call(
				'transcribe',
				{
					samples: request.audio.data.slice(chunk.start, chunk.end),
					sampleRate: request.audio.sampleRate
				},
				signal
			);
			const result = decodeResult(value);
			const text = result.text.trim();
			if (text === '') continue;
			const start = chunk.start / request.audio.sampleRate;
			const end = chunk.end / request.audio.sampleRate;
			const chunkWords = request.timestampGranularities.includes('word')
				? mapParakeetWordTimestamps(result, start, end)
				: undefined;
			if (request.timestampGranularities.includes('word') && chunkWords === undefined) {
				wordsAvailable = false;
			}
			if (chunkWords !== undefined) words.push(...chunkWords);
			texts.push(text);
			segments.push({
				id: segments.length,
				start,
				end,
				text,
				...(chunkWords === undefined ? {} : { words: chunkWords })
			});
		}
		return {
			text: texts.join(' '),
			language: 'en',
			duration,
			segments,
			...(wordsAvailable ? { words } : {})
		};
	}

	async *transcribeStream(
		request: TranscriptionRequest,
		signal: AbortSignal
	): AsyncIterable<TranscriptionEvent> {
		const result = await this.transcribe(request, signal);
		if (result.text !== '') yield { type: 'delta', delta: result.text };
		yield { type: 'done', text: result.text };
	}

	async close(): Promise<void> {
		await this.#client.close?.();
	}
}
