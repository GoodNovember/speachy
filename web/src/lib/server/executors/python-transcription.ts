import { endianness } from 'node:os';
import { transcriptionStreamEventSchema, verboseTranscriptionSchema } from '$lib/types/api';
import { SHERPA_WHISPER_MODEL_ID } from '../native-whisper.ts';
import {
	listLocalModelsByTask,
	listRemoteCatalogModelsByTask,
	type CatalogModel
} from '../model-catalog.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type {
	Audio,
	Model,
	Transcription,
	TranscriptionExecutor,
	TranscriptionEvent,
	TranscriptionRequest,
	TranslationRequest,
	VadOptions
} from './types.ts';

type PythonTranscriptionRpc = {
	request(
		method: string,
		params: Record<string, unknown>,
		options?: PythonWorkerRequestOptions
	): Promise<unknown>;
};

type TranscriptionCatalog = {
	listLocal(): Promise<CatalogModel[]>;
	listRemote(): Promise<CatalogModel[]>;
};

const catalog: TranscriptionCatalog = {
	listLocal: async () =>
		(await listLocalModelsByTask('automatic-speech-recognition')).filter(
			(model) => model.id !== SHERPA_WHISPER_MODEL_ID
		),
	listRemote: () => listRemoteCatalogModelsByTask('automatic-speech-recognition')
};

function modelFromCatalog(model: CatalogModel): Model {
	return {
		id: model.id,
		created: model.created,
		ownedBy: model.owned_by,
		task: 'automatic-speech-recognition',
		...(model.language === null || model.language === undefined ? {} : { language: model.language })
	};
}

export function encodeRpcAudio(audio: Audio): Record<string, unknown> {
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

function encodeVadOptions(options: VadOptions): Record<string, unknown> {
	return {
		threshold: options.threshold,
		neg_threshold: options.negThreshold ?? null,
		min_speech_duration_ms: options.minSpeechDurationMs,
		// JSON has no infinity. Null is the protocol spelling for no maximum.
		max_speech_duration_s: Number.isFinite(options.maxSpeechDurationS)
			? options.maxSpeechDurationS
			: null,
		min_silence_duration_ms: options.minSilenceDurationMs,
		speech_pad_ms: options.speechPadMs
	};
}

export function encodeTranscriptionRequest(request: TranscriptionRequest): Record<string, unknown> {
	return {
		audio: encodeRpcAudio(request.audio),
		model: request.model,
		language: request.language ?? null,
		prompt: request.prompt ?? null,
		response_format: request.responseFormat,
		temperature: request.temperature,
		hotwords: request.hotwords ?? null,
		timestamp_granularities: request.timestampGranularities,
		speech_segments: request.speechSegments,
		vad_options: encodeVadOptions(request.vadOptions),
		without_timestamps: request.withoutTimestamps
	};
}

export function encodeTranslationRequest(request: TranslationRequest): Record<string, unknown> {
	return {
		audio: encodeRpcAudio(request.audio),
		model: request.model,
		prompt: request.prompt ?? null,
		response_format: request.responseFormat,
		temperature: request.temperature,
		speech_segments: request.speechSegments,
		vad_options: encodeVadOptions(request.vadOptions)
	};
}

function parseTranscription(value: unknown): Transcription {
	const parsed = verboseTranscriptionSchema.parse(value);
	return {
		text: parsed.text,
		...(parsed.language === undefined ? {} : { language: parsed.language }),
		...(parsed.duration === undefined ? {} : { duration: parsed.duration }),
		...(parsed.segments === undefined || parsed.segments === null
			? {}
			: { segments: parsed.segments }),
		...(parsed.words === undefined || parsed.words === null ? {} : { words: parsed.words })
	};
}

export class PythonTranscriptionExecutor implements TranscriptionExecutor {
	readonly name = 'python-transcription';
	readonly task = 'automatic-speech-recognition' as const;

	readonly #worker: PythonTranscriptionRpc;
	readonly #catalog: TranscriptionCatalog;

	constructor(worker: PythonTranscriptionRpc, modelCatalog: TranscriptionCatalog = catalog) {
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

	async transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcription> {
		const response = await this.#worker.request('transcribe', encodeTranscriptionRequest(request), {
			signal
		});
		return parseTranscription(response);
	}

	async translate(request: TranslationRequest, signal: AbortSignal): Promise<Transcription> {
		const response = await this.#worker.request('translate', encodeTranslationRequest(request), {
			signal
		});
		return parseTranscription(response);
	}

	async *transcribeStream(
		request: TranscriptionRequest,
		signal: AbortSignal
	): AsyncIterable<TranscriptionEvent> {
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
			.request('transcribe_stream', encodeTranscriptionRequest(request), {
				signal: controller.signal,
				onEvent: (event) => {
					queued.push(event);
					wake();
				}
			})
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
		let text = '';
		let done = false;
		try {
			for (;;) {
				while (queued.length > 0) {
					const event = transcriptionStreamEventSchema.parse(queued.shift());
					eventCount += 1;
					if (event.type === 'transcript.text.delta') {
						if (done) throw new Error('Python transcription stream emitted a delta after done');
						text += event.delta;
						yield { type: 'delta', delta: event.delta };
					} else {
						if (done)
							throw new Error('Python transcription stream emitted more than one done event');
						done = true;
						yield { type: 'done', text };
					}
				}
				if (settled) break;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			await pending;
			if (failure !== undefined) throw failure;
			if (
				!done ||
				typeof terminal !== 'object' ||
				terminal === null ||
				(terminal as Record<string, unknown>).event_count !== eventCount
			) {
				throw new Error('Python transcription stream ended with an invalid event count');
			}
		} finally {
			signal.removeEventListener('abort', forwardAbort);
			if (!settled) controller.abort(new Error('Transcription stream consumer closed'));
			await pending;
		}
	}
}
