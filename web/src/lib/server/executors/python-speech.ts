import {
	listLocalModelsByTask,
	listRemoteCatalogModelsByTask,
	type CatalogModel
} from '../model-catalog.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type { Audio, Model, SpeechExecutor, SpeechRequest } from './types.ts';

type PythonSpeechRpc = {
	request(
		method: string,
		params: Record<string, unknown>,
		options?: PythonWorkerRequestOptions
	): Promise<unknown>;
};

type SpeechCatalog = {
	listLocal(): Promise<CatalogModel[]>;
	listRemote(): Promise<CatalogModel[]>;
};

const catalog: SpeechCatalog = {
	listLocal: () => listLocalModelsByTask('text-to-speech'),
	listRemote: () => listRemoteCatalogModelsByTask('text-to-speech')
};

function modelFromCatalog(model: CatalogModel): Model {
	return {
		id: model.id,
		created: model.created,
		ownedBy: model.owned_by,
		task: 'text-to-speech',
		...(model.language === null || model.language === undefined ? {} : { language: model.language })
	};
}

function decodeAudioEvent(value: unknown): Audio {
	if (typeof value !== 'object' || value === null) throw new Error('Invalid speech audio event');
	const event = value as Record<string, unknown>;
	if (
		event.type !== 'speech.audio.delta' ||
		typeof event.audio !== 'object' ||
		event.audio === null
	) {
		throw new Error('Invalid speech audio event');
	}
	const audio = event.audio as Record<string, unknown>;
	if (
		audio.encoding !== 'f32le-base64' ||
		typeof audio.data !== 'string' ||
		typeof audio.sample_rate !== 'number' ||
		!Number.isInteger(audio.sample_rate) ||
		audio.sample_rate <= 0
	) {
		throw new Error('Invalid speech audio payload');
	}
	const bytes = Buffer.from(audio.data, 'base64');
	if (bytes.toString('base64') !== audio.data || bytes.byteLength % 4 !== 0) {
		throw new Error('Invalid speech audio payload');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const data = new Float32Array(bytes.byteLength / 4);
	for (let index = 0; index < data.length; index += 1) {
		const sample = view.getFloat32(index * 4, true);
		if (!Number.isFinite(sample)) throw new Error('Speech audio contains a non-finite sample');
		data[index] = sample;
	}
	return { data, sampleRate: audio.sample_rate };
}

export class PythonSpeechExecutor implements SpeechExecutor {
	readonly name = 'python-speech';
	readonly task = 'text-to-speech' as const;

	readonly #worker: PythonSpeechRpc;
	readonly #catalog: SpeechCatalog;

	constructor(worker: PythonSpeechRpc, modelCatalog: SpeechCatalog = catalog) {
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

	async listVoices(modelId: string): Promise<string[]> {
		const model = (await this.#catalog.listLocal()).find((candidate) => candidate.id === modelId);
		return model?.voices?.map((voice) => voice.name) ?? [];
	}

	async *synthesize(request: SpeechRequest, signal: AbortSignal): AsyncIterable<Audio> {
		const controller = new AbortController();
		const forwardAbort = (): void => controller.abort(signal.reason);
		if (signal.aborted) forwardAbort();
		else signal.addEventListener('abort', forwardAbort, { once: true });

		const queued: unknown[] = [];
		let notify: (() => void) | undefined;
		let settled = false;
		let terminal: unknown;
		let failure: unknown;
		const wake = (): void => {
			notify?.();
			notify = undefined;
		};
		const pending = this.#worker
			.request(
				'synthesize',
				{
					model: request.model,
					voice: request.voice,
					text: request.text,
					speed: request.speed
				},
				{
					signal: controller.signal,
					onEvent: (event) => {
						queued.push(event);
						wake();
					}
				}
			)
			.then(
				(value) => {
					terminal = value;
				},
				(error: unknown) => {
					failure = error;
				}
			)
			.finally(() => {
				settled = true;
				wake();
			});

		let eventCount = 0;
		try {
			for (;;) {
				while (queued.length > 0) {
					eventCount += 1;
					yield decodeAudioEvent(queued.shift());
				}
				if (settled) break;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			await pending;
			if (failure !== undefined) throw failure;
			if (
				typeof terminal !== 'object' ||
				terminal === null ||
				(terminal as Record<string, unknown>).event_count !== eventCount
			) {
				throw new Error('Python speech stream ended with an invalid event count');
			}
		} finally {
			signal.removeEventListener('abort', forwardAbort);
			if (!settled) controller.abort(new Error('Speech stream consumer closed'));
			await pending;
		}
	}
}
