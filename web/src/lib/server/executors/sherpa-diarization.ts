import { createRequire } from 'node:module';
import { resampleAudioData } from '../audio.ts';
import {
	hasSherpaDiarizationModel,
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_MODEL_ID,
	sherpaDiarizationCreatedAt,
	type SherpaDiarizationModelPaths
} from '../native-diarization.ts';
import type {
	DiarizationExecutor,
	DiarizationRequest,
	DiarizationSegment,
	Model
} from './types.ts';
import { WorkerPool } from './worker-pool.ts';
import sherpaWorkerSource from './sherpa-diarization-worker.cjs?raw';

const SHERPA_SAMPLE_RATE = 16_000;

type NativeDiarizationClient = {
	call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
	close?(): Promise<void>;
};

type NativeDiarizationSegment = {
	start: number;
	end: number;
	speaker: number;
};

export type SherpaDiarizationExecutorOptions = {
	paths?: SherpaDiarizationModelPaths;
	client?: NativeDiarizationClient;
	workerCount?: number;
	modelThreads?: number;
};

function decodeSegments(value: unknown): NativeDiarizationSegment[] {
	if (!Array.isArray(value)) throw new Error('Sherpa returned an invalid diarization result');
	return value.map((item) => {
		if (typeof item !== 'object' || item === null) {
			throw new Error('Sherpa returned an invalid diarization segment');
		}
		const segment = item as Record<string, unknown>;
		if (
			typeof segment.start !== 'number' ||
			!Number.isFinite(segment.start) ||
			segment.start < 0 ||
			typeof segment.end !== 'number' ||
			!Number.isFinite(segment.end) ||
			segment.end <= segment.start ||
			typeof segment.speaker !== 'number' ||
			!Number.isSafeInteger(segment.speaker) ||
			segment.speaker < 0
		) {
			throw new Error('Sherpa returned an invalid diarization segment');
		}
		return segment as NativeDiarizationSegment;
	});
}

function speakerLabel(index: number): string {
	return `SPEAKER_${String(index).padStart(2, '0')}`;
}

export class SherpaDiarizationExecutor implements DiarizationExecutor {
	readonly name = 'sherpa-diarization-native';
	readonly task = 'speaker-diarization' as const;

	readonly #paths: SherpaDiarizationModelPaths;
	readonly #client: NativeDiarizationClient;

	constructor(options: SherpaDiarizationExecutorOptions = {}) {
		this.#paths = options.paths ?? resolveSherpaDiarizationModelPaths();
		this.#client =
			options.client ??
			new WorkerPool({
				script: sherpaWorkerSource,
				eval: true,
				size: options.workerCount ?? 1,
				workerData: {
					segmentation: this.#paths.segmentation,
					embedding: this.#paths.embedding,
					numThreads: options.modelThreads ?? 2,
					modulePath: createRequire(import.meta.url).resolve('sherpa-onnx-node')
				},
				name: 'sherpa-diarization'
			});
	}

	async listLocalModels(): Promise<Model[]> {
		if (!hasSherpaDiarizationModel(this.#paths)) return [];
		return [
			{
				id: SHERPA_DIARIZATION_MODEL_ID,
				created: await sherpaDiarizationCreatedAt(this.#paths),
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
		return modelId === SHERPA_DIARIZATION_MODEL_ID && hasSherpaDiarizationModel(this.#paths);
	}

	async diarize(request: DiarizationRequest, signal: AbortSignal): Promise<DiarizationSegment[]> {
		if (request.modelId !== SHERPA_DIARIZATION_MODEL_ID) {
			throw new Error(`Only '${SHERPA_DIARIZATION_MODEL_ID}' is supported`);
		}
		if (!hasSherpaDiarizationModel(this.#paths)) {
			throw new Error(`Native model '${SHERPA_DIARIZATION_MODEL_ID}' is not installed`);
		}
		if (
			request.numSpeakers !== undefined &&
			(!Number.isSafeInteger(request.numSpeakers) || request.numSpeakers <= 0)
		) {
			throw new RangeError('numSpeakers must be a positive integer');
		}
		if (signal.aborted) throw signal.reason;
		const samples =
			request.audio.sampleRate === SHERPA_SAMPLE_RATE
				? request.audio.data
				: resampleAudioData(request.audio.data, request.audio.sampleRate, SHERPA_SAMPLE_RATE);
		const value = await this.#client.call(
			'diarize',
			{
				samples,
				sampleRate: SHERPA_SAMPLE_RATE,
				numSpeakers: request.numSpeakers ?? 0
			},
			signal
		);
		return decodeSegments(value)
			.map((segment) => ({
				start: segment.start,
				end: segment.end,
				speaker: speakerLabel(segment.speaker)
			}))
			.sort((left, right) =>
				left.start !== right.start
					? left.start - right.start
					: left.end !== right.end
						? left.end - right.end
						: left.speaker.localeCompare(right.speaker)
			);
	}

	async close(): Promise<void> {
		await this.#client.close?.();
	}
}
