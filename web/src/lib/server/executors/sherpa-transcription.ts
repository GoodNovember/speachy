import { createRequire } from 'node:module';
import {
	hasSherpaWhisperModel,
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_MODEL_ID,
	sherpaWhisperCreatedAt,
	type SherpaWhisperModelPaths
} from '../native-whisper.ts';
import type {
	Model,
	Transcription,
	TranscriptionEvent,
	TranscriptionExecutor,
	TranscriptionRequest
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

const MAX_WHISPER_CHUNK_SECONDS = 29;

export type SherpaWhisperExecutorOptions = {
	paths?: SherpaWhisperModelPaths;
	client?: NativeTranscriptionClient;
	workerCount?: number;
	modelThreads?: number;
};

function validateRequest(request: TranscriptionRequest): void {
	if (request.model !== SHERPA_WHISPER_MODEL_ID) {
		throw new Error(`Only '${SHERPA_WHISPER_MODEL_ID}' is supported`);
	}
	if (request.language !== undefined && !/^en(?:-|$)/i.test(request.language)) {
		throw new Error('The native Whisper tiny.en model only supports English');
	}
	if (request.temperature !== 0) {
		throw new Error('The native Whisper executor currently requires temperature 0');
	}
	if (request.prompt !== undefined || request.hotwords !== undefined) {
		throw new Error('The native Whisper executor does not yet support prompts or hotwords');
	}
}

function decodeResult(value: unknown): { text: string; language: string } {
	if (
		typeof value !== 'object' ||
		value === null ||
		typeof (value as { text?: unknown }).text !== 'string'
	) {
		throw new Error('Sherpa returned an invalid transcription result');
	}
	const result = value as NativeRecognitionResult;
	return {
		text: result.text.trim(),
		language: result.lang?.trim() || 'en'
	};
}

function chunkSpeechSegments(
	segments: TranscriptionRequest['speechSegments'],
	sampleCount: number,
	sampleRate: number
): { start: number; end: number }[] {
	const maxSamples = Math.max(1, Math.floor(MAX_WHISPER_CHUNK_SECONDS * sampleRate));
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

export class SherpaWhisperTranscriptionExecutor implements TranscriptionExecutor {
	readonly name = 'sherpa-whisper-native';
	readonly task = 'automatic-speech-recognition' as const;

	readonly #paths: SherpaWhisperModelPaths;
	readonly #client: NativeTranscriptionClient;

	constructor(options: SherpaWhisperExecutorOptions = {}) {
		this.#paths = options.paths ?? resolveSherpaWhisperModelPaths();
		this.#client =
			options.client ??
			new WorkerPool({
				script: sherpaWorkerSource,
				eval: true,
				size: options.workerCount ?? 1,
				workerData: {
					modelDirectory: this.#paths.directory,
					numThreads: options.modelThreads ?? 2,
					modulePath: createRequire(import.meta.url).resolve('sherpa-onnx-node')
				},
				name: 'sherpa-whisper'
			});
	}

	async listLocalModels(): Promise<Model[]> {
		if (!hasSherpaWhisperModel(this.#paths)) return [];
		return [
			{
				id: SHERPA_WHISPER_MODEL_ID,
				created: await sherpaWhisperCreatedAt(this.#paths),
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
		return modelId === SHERPA_WHISPER_MODEL_ID && hasSherpaWhisperModel(this.#paths);
	}

	async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcription> {
		validateRequest(request);
		if (!hasSherpaWhisperModel(this.#paths)) {
			throw new Error(`Native model '${SHERPA_WHISPER_MODEL_ID}' is not installed`);
		}
		const duration = request.audio.data.length / request.audio.sampleRate;
		const chunks = chunkSpeechSegments(
			request.speechSegments,
			request.audio.data.length,
			request.audio.sampleRate
		);
		const texts: string[] = [];
		const segments: NonNullable<Transcription['segments']> = [];
		let language = 'en';
		for (const chunk of chunks) {
			if (signal.aborted) throw signal.reason;
			// Copy only this window. Passing a subarray would retain the entire
			// long-form recording while the worker processes a 29-second chunk.
			const value = await this.#client.call(
				'transcribe',
				{
					samples: request.audio.data.slice(chunk.start, chunk.end),
					sampleRate: request.audio.sampleRate
				},
				signal
			);
			const result = decodeResult(value);
			language = result.language;
			if (result.text === '') continue;
			texts.push(result.text);
			segments.push({
				id: segments.length,
				start: chunk.start / request.audio.sampleRate,
				end: chunk.end / request.audio.sampleRate,
				text: result.text
			});
		}
		return { text: texts.join(' '), language, duration, segments };
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
