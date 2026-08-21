import { endianness } from 'node:os';
import {
	listLocalModelsByTask,
	listRemoteCatalogModelsByTask,
	type CatalogModel
} from '../model-catalog.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type { Audio, Model, SpeakerEmbeddingExecutor, SpeakerEmbeddingRequest } from './types.ts';

type PythonEmbeddingRpc = {
	request(
		method: string,
		params: Record<string, unknown>,
		options?: PythonWorkerRequestOptions
	): Promise<unknown>;
};

type EmbeddingCatalog = {
	listLocal(): Promise<CatalogModel[]>;
	listRemote(): Promise<CatalogModel[]>;
};

const catalog: EmbeddingCatalog = {
	listLocal: () => listLocalModelsByTask('speaker-embedding'),
	listRemote: () => listRemoteCatalogModelsByTask('speaker-embedding')
};

function modelFromCatalog(model: CatalogModel): Model {
	return {
		id: model.id,
		created: model.created,
		ownedBy: model.owned_by,
		task: 'speaker-embedding'
	};
}

function encodeAudio(audio: Audio): Record<string, unknown> {
	let bytes: Uint8Array;
	if (endianness() === 'LE') {
		bytes = new Uint8Array(audio.data.buffer, audio.data.byteOffset, audio.data.byteLength);
	} else {
		bytes = new Uint8Array(audio.data.length * 4);
		const view = new DataView(bytes.buffer);
		for (let index = 0; index < audio.data.length; index += 1) {
			view.setFloat32(index * 4, audio.data[index]!, true);
		}
	}
	return {
		encoding: 'f32le-base64',
		data: Buffer.from(bytes).toString('base64'),
		sample_rate: audio.sampleRate,
		...(audio.name === undefined ? {} : { name: audio.name })
	};
}

function decodeEmbedding(value: unknown): Float32Array {
	if (typeof value !== 'object' || value === null) throw new Error('Invalid speaker embedding');
	const encoded = value as Record<string, unknown>;
	if (
		encoded.encoding !== 'f32le-base64' ||
		typeof encoded.data !== 'string' ||
		typeof encoded.length !== 'number' ||
		!Number.isSafeInteger(encoded.length) ||
		encoded.length < 0
	) {
		throw new Error('Invalid speaker embedding');
	}
	const bytes = Buffer.from(encoded.data, 'base64');
	if (bytes.toString('base64') !== encoded.data || bytes.byteLength !== encoded.length * 4) {
		throw new Error('Invalid speaker embedding');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const embedding = new Float32Array(encoded.length);
	for (let index = 0; index < embedding.length; index += 1) {
		const component = view.getFloat32(index * 4, true);
		if (!Number.isFinite(component))
			throw new Error('Speaker embedding contains a non-finite value');
		embedding[index] = component;
	}
	return embedding;
}

export class PythonSpeakerEmbeddingExecutor implements SpeakerEmbeddingExecutor {
	readonly name = 'python-speaker-embedding';
	readonly task = 'speaker-embedding' as const;

	readonly #worker: PythonEmbeddingRpc;
	readonly #catalog: EmbeddingCatalog;

	constructor(worker: PythonEmbeddingRpc, modelCatalog: EmbeddingCatalog = catalog) {
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

	async embed(request: SpeakerEmbeddingRequest, signal: AbortSignal): Promise<Float32Array> {
		const result = await this.#worker.request(
			'embed',
			{ audio: encodeAudio(request.audio), model_id: request.modelId },
			{ signal }
		);
		return decodeEmbedding(result);
	}
}
