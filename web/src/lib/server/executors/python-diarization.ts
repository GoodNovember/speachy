import {
	listLocalModelsByTask,
	listRemoteCatalogModelsByTask,
	type CatalogModel
} from '../model-catalog.ts';
import { SHERPA_DIARIZATION_MODEL_ID } from '../native-diarization.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import { encodeRpcAudio } from './python-transcription.ts';
import type {
	DiarizationExecutor,
	DiarizationRequest,
	DiarizationSegment,
	Model
} from './types.ts';

type PythonDiarizationRpc = {
	request(
		method: string,
		params: Record<string, unknown>,
		options?: PythonWorkerRequestOptions
	): Promise<unknown>;
};

type DiarizationCatalog = {
	listLocal(): Promise<CatalogModel[]>;
	listRemote(): Promise<CatalogModel[]>;
};

const catalog: DiarizationCatalog = {
	listLocal: async () =>
		(await listLocalModelsByTask('speaker-diarization')).filter(
			(model) => model.id !== SHERPA_DIARIZATION_MODEL_ID
		),
	listRemote: () => listRemoteCatalogModelsByTask('speaker-diarization')
};

function modelFromCatalog(model: CatalogModel): Model {
	return {
		id: model.id,
		created: model.created,
		ownedBy: model.owned_by,
		task: 'speaker-diarization'
	};
}

function parseSegments(value: unknown): DiarizationSegment[] {
	if (!Array.isArray(value)) throw new Error('Invalid diarization result');
	return value.map((item) => {
		if (typeof item !== 'object' || item === null) throw new Error('Invalid diarization segment');
		const segment = item as Record<string, unknown>;
		if (
			typeof segment.start !== 'number' ||
			!Number.isFinite(segment.start) ||
			segment.start < 0 ||
			typeof segment.end !== 'number' ||
			!Number.isFinite(segment.end) ||
			segment.end <= segment.start ||
			typeof segment.speaker !== 'string' ||
			segment.speaker.length === 0
		) {
			throw new Error('Invalid diarization segment');
		}
		return { start: segment.start, end: segment.end, speaker: segment.speaker };
	});
}

export class PythonDiarizationExecutor implements DiarizationExecutor {
	readonly name = 'python-diarization';
	readonly task = 'speaker-diarization' as const;

	readonly #worker: PythonDiarizationRpc;
	readonly #catalog: DiarizationCatalog;

	constructor(worker: PythonDiarizationRpc, modelCatalog: DiarizationCatalog = catalog) {
		this.#worker = worker;
		this.#catalog = modelCatalog;
	}

	async listLocalModels(): Promise<Model[]> {
		return (await this.#catalog.listLocal()).map(modelFromCatalog);
	}

	async listRemoteModels(): Promise<Model[]> {
		return (await this.#catalog.listRemote()).map(modelFromCatalog);
	}

	async canHandle(modelId: string): Promise<boolean> {
		return (await this.#catalog.listLocal()).some((model) => model.id === modelId);
	}

	async diarize(request: DiarizationRequest, signal: AbortSignal): Promise<DiarizationSegment[]> {
		const result = await this.#worker.request(
			'diarize',
			{
				audio: encodeRpcAudio(request.audio),
				model_id: request.modelId,
				num_speakers: request.numSpeakers ?? null
			},
			{ signal }
		);
		return parseSegments(result);
	}
}
