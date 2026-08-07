import {
	listAudioModelsSchema,
	listModelsSchema,
	listVoicesSchema,
	runningModelsSchema,
	speechStreamEventSchema,
	speechTimestampsSchema,
	transcriptionSchema,
	transcriptionStreamEventSchema,
	verboseTranscriptionSchema,
	type Model,
	type ModelTask,
	type ResponseFormat,
	type SpeechFormat,
	type SpeechTimestamp,
	type TranscriptionStreamEvent,
	type VerboseTranscription,
	type Voice
} from '$lib/types/api';
import { errorFromResponse } from './errors';
import { parseSseJson } from './sse';

// Same-origin by design: /v1/* is proxied to the reference in Phase 1 and
// served directly in Phase 2, so nothing here changes when the backend swaps.

export type ClientOptions = {
	apiKey?: string;
	fetch?: typeof globalThis.fetch;
	baseUrl?: string;
};

export type TranscribeOptions = {
	file: Blob;
	fileName?: string;
	model: string;
	language?: string;
	prompt?: string;
	responseFormat?: ResponseFormat;
	temperature?: number;
	wordTimestamps?: boolean;
	hotwords?: string;
	signal?: AbortSignal;
};

export type SynthesizeOptions = {
	model: string;
	voice: string;
	input: string;
	responseFormat?: SpeechFormat;
	speed?: number;
	signal?: AbortSignal;
};

export class SpeachyClient {
	#apiKey: string | undefined;
	#fetch: typeof globalThis.fetch;
	#baseUrl: string;

	constructor(options: ClientOptions = {}) {
		this.#apiKey = options.apiKey?.trim() || undefined;
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.#baseUrl = options.baseUrl ?? '';
	}

	#url(path: string): string {
		return `${this.#baseUrl}${path}`;
	}

	#headers(extra: Record<string, string> = {}): Headers {
		const headers = new Headers(extra);
		if (this.#apiKey !== undefined) headers.set('authorization', `Bearer ${this.#apiKey}`);
		return headers;
	}

	async #request(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await this.#fetch(this.#url(path), {
			...init,
			headers: this.#headers(Object.fromEntries(new Headers(init.headers).entries()))
		});
		if (!response.ok) throw await errorFromResponse(response);
		return response;
	}

	async #json<T>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> {
		const response = await this.#request(path, init);
		return parse(await response.json());
	}

	// --- models ----------------------------------------------------------

	async listModels(task?: ModelTask): Promise<Model[]> {
		const query = task === undefined ? '' : `?task=${encodeURIComponent(task)}`;
		const parsed = await this.#json(`/v1/models${query}`, (v) => listModelsSchema.parse(v));
		return parsed.data;
	}

	async listRegistry(task?: ModelTask): Promise<Model[]> {
		const query = task === undefined ? '' : `?task=${encodeURIComponent(task)}`;
		const parsed = await this.#json(`/v1/registry${query}`, (v) => listModelsSchema.parse(v));
		return parsed.data;
	}

	async listSpeechModels(): Promise<Model[]> {
		const parsed = await this.#json('/v1/audio/models', (v) => listAudioModelsSchema.parse(v));
		return parsed.models;
	}

	async listVoices(): Promise<Voice[]> {
		const parsed = await this.#json('/v1/audio/voices', (v) => listVoicesSchema.parse(v));
		return parsed.voices;
	}

	async listLoadedModels(): Promise<string[]> {
		const parsed = await this.#json('/api/ps', (v) => runningModelsSchema.parse(v));
		return parsed.models;
	}

	async downloadModel(modelId: string): Promise<void> {
		await this.#request(`/v1/models/${modelId}`, { method: 'POST' });
	}

	async deleteModel(modelId: string): Promise<void> {
		await this.#request(`/v1/models/${modelId}`, { method: 'DELETE' });
	}

	async unloadModel(modelId: string): Promise<void> {
		await this.#request(`/api/ps/${modelId}`, { method: 'DELETE' });
	}

	// --- transcription ---------------------------------------------------

	#transcriptionForm(options: TranscribeOptions, stream: boolean): FormData {
		const form = new FormData();
		form.set('file', options.file, options.fileName ?? 'audio.wav');
		form.set('model', options.model);
		form.set('response_format', options.responseFormat ?? 'json');
		if (options.language) form.set('language', options.language);
		if (options.prompt) form.set('prompt', options.prompt);
		if (options.temperature !== undefined) form.set('temperature', String(options.temperature));
		if (options.hotwords) form.set('hotwords', options.hotwords);
		if (stream) form.set('stream', 'true');
		if (options.wordTimestamps) {
			// The bracketed name is what the server actually reads.
			form.append('timestamp_granularities[]', 'segment');
			form.append('timestamp_granularities[]', 'word');
		}
		return form;
	}

	async transcribe(options: TranscribeOptions): Promise<string> {
		const format = options.responseFormat ?? 'json';
		const response = await this.#request('/v1/audio/transcriptions', {
			method: 'POST',
			body: this.#transcriptionForm(options, false),
			signal: options.signal
		});
		if (format === 'json') return transcriptionSchema.parse(await response.json()).text;
		if (format === 'verbose_json') return JSON.stringify(await response.json(), null, 2);
		return response.text();
	}

	async transcribeVerbose(options: TranscribeOptions): Promise<VerboseTranscription> {
		const response = await this.#request('/v1/audio/transcriptions', {
			method: 'POST',
			body: this.#transcriptionForm({ ...options, responseFormat: 'verbose_json' }, false),
			signal: options.signal
		});
		return verboseTranscriptionSchema.parse(await response.json());
	}

	async *transcribeStream(options: TranscribeOptions): AsyncGenerator<TranscriptionStreamEvent> {
		const response = await this.#request('/v1/audio/transcriptions', {
			method: 'POST',
			body: this.#transcriptionForm(options, true),
			signal: options.signal
		});
		if (response.body === null) throw new Error('Transcription stream had no body');
		yield* parseSseJson(
			response.body,
			(value) => transcriptionStreamEventSchema.parse(value),
			options.signal
		);
	}

	// --- speech ----------------------------------------------------------

	async synthesize(options: SynthesizeOptions): Promise<Blob> {
		const response = await this.#request('/v1/audio/speech', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: options.model,
				voice: options.voice,
				input: options.input,
				response_format: options.responseFormat ?? 'wav',
				speed: options.speed ?? 1
			}),
			signal: options.signal
		});
		return response.blob();
	}

	async *synthesizeStream(options: SynthesizeOptions): AsyncGenerator<Uint8Array> {
		const response = await this.#request('/v1/audio/speech', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: options.model,
				voice: options.voice,
				input: options.input,
				speed: options.speed ?? 1,
				stream_format: 'sse'
			}),
			signal: options.signal
		});
		if (response.body === null) throw new Error('Speech stream had no body');
		for await (const event of parseSseJson(
			response.body,
			(value) => speechStreamEventSchema.parse(value),
			options.signal
		)) {
			if (event.type !== 'speech.audio.delta') continue;
			yield Uint8Array.from(atob(event.audio), (c) => c.charCodeAt(0));
		}
	}

	// --- vad -------------------------------------------------------------

	async detectSpeech(file: Blob, fileName = 'audio.wav'): Promise<SpeechTimestamp[]> {
		const form = new FormData();
		form.set('file', file, fileName);
		return this.#json('/v1/audio/speech/timestamps', (v) => speechTimestampsSchema.parse(v), {
			method: 'POST',
			body: form
		});
	}
}
