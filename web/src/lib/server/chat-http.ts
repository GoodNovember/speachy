import { randomUUID } from 'node:crypto';
import { parseSseStream } from '$lib/api/sse';
import { createSpeechResponse } from './speech-http.ts';
import { createTranscriptionResponse } from './transcription-http.ts';
import { APIProxyError } from './errors.ts';
import {
	getSpeechExecutors,
	getTranscriptionExecutors,
	getVadExecutor
} from './executors/executor-registry.ts';
import { getConfig } from './runtime.ts';
import { formatAsSse, SentenceChunker } from './text-utils.ts';

type JsonObject = Record<string, unknown>;
type AudioFormat = 'wav' | 'mp3' | 'flac' | 'opus' | 'aac' | 'pcm16';
type AudioOutput = { voice: string; format: AudioFormat };
type BackendResult =
	{ stream: false; completion: JsonObject } | { stream: true; chunks: AsyncIterable<JsonObject> };

export type ChatRuntime = {
	complete(body: JsonObject, signal: AbortSignal): Promise<BackendResult>;
	transcribe(
		data: Uint8Array,
		format: string,
		model: string,
		extraBody: JsonObject | undefined,
		signal: AbortSignal
	): Promise<string>;
	speak(
		text: string,
		model: string,
		audio: AudioOutput,
		extraBody: JsonObject | undefined,
		signal: AbortSignal
	): Promise<Response>;
};

type ParsedRequest = {
	body: JsonObject;
	stream: boolean;
	wantsAudio: boolean;
	audio?: AudioOutput;
	transcriptionModel: string;
	transcriptionExtraBody?: JsonObject;
	speechModel: string;
	speechExtraBody?: JsonObject;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

const AUDIO_TRANSCRIPTION_TTL_MS = 60 * 60 * 1000;
const AUDIO_TRANSCRIPTION_CACHE_SIZE = 4096;
const AUDIO_FORMATS = new Set<AudioFormat>(['wav', 'mp3', 'flac', 'opus', 'aac', 'pcm16']);
const audioTranscripts = new Map<string, { transcript: string; expiresAt: number }>();

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationError(field: string, message: string, input: unknown): Response {
	return Response.json(
		{
			detail: [{ type: 'value_error', loc: ['body', ...field.split('.')], msg: message, input }]
		},
		{ status: 422 }
	);
}

function optionalRecord(body: JsonObject, field: string): Parsed<JsonObject | undefined> {
	const value = body[field];
	if (value === undefined || value === null) return { ok: true, value: undefined };
	if (!isRecord(value)) {
		return { ok: false, response: validationError(field, 'Input should be a valid object', value) };
	}
	return { ok: true, value };
}

function parseRequest(value: unknown): Parsed<ParsedRequest> {
	if (!isRecord(value)) {
		return {
			ok: false,
			response: validationError('body', 'Input should be a valid object', value)
		};
	}
	if (typeof value.model !== 'string' || value.model.length === 0) {
		return { ok: false, response: validationError('model', 'Field required', value.model ?? null) };
	}
	if (!Array.isArray(value.messages)) {
		return {
			ok: false,
			response: validationError('messages', 'Input should be a valid list', value.messages ?? null)
		};
	}
	if (value.n !== undefined && value.n !== null && value.n !== 1) {
		return {
			ok: false,
			response: validationError('n', 'Multiple choices (`n` > 1) are not supported', value.n)
		};
	}
	const stream = value.stream === undefined ? false : value.stream;
	if (typeof stream !== 'boolean') {
		return {
			ok: false,
			response: validationError('stream', 'Input should be a valid boolean', stream)
		};
	}
	const modalities = value.modalities === undefined ? ['text'] : value.modalities;
	if (
		!Array.isArray(modalities) ||
		modalities.some((modality) => modality !== 'text' && modality !== 'audio')
	) {
		return {
			ok: false,
			response: validationError(
				'modalities',
				"Input should contain only 'text' and 'audio'",
				modalities
			)
		};
	}
	const wantsAudio = modalities.includes('audio');
	let audio: AudioOutput | undefined;
	if (wantsAudio) {
		if (!isRecord(value.audio)) {
			return {
				ok: false,
				response: validationError('audio', 'Audio configuration is required', value.audio ?? null)
			};
		}
		if (typeof value.audio.voice !== 'string' || value.audio.voice.length === 0) {
			return {
				ok: false,
				response: validationError('audio.voice', 'Field required', value.audio.voice ?? null)
			};
		}
		if (
			typeof value.audio.format !== 'string' ||
			!AUDIO_FORMATS.has(value.audio.format as AudioFormat)
		) {
			return {
				ok: false,
				response: validationError(
					'audio.format',
					'Unsupported audio format',
					value.audio.format ?? null
				)
			};
		}
		audio = { voice: value.audio.voice, format: value.audio.format as AudioFormat };
		if (stream && audio.format !== 'pcm16') {
			return {
				ok: false,
				response: validationError(
					'audio.format',
					"Streaming audio only supports 'pcm16'",
					audio.format
				)
			};
		}
	}
	const transcriptionModel = value.transcription_model ?? 'whisper-1';
	if (typeof transcriptionModel !== 'string' || transcriptionModel.length === 0) {
		return {
			ok: false,
			response: validationError(
				'transcription_model',
				'Input should be a valid string',
				transcriptionModel
			)
		};
	}
	const speechModel = value.speech_model ?? 'tts-1';
	if (typeof speechModel !== 'string' || speechModel.length === 0) {
		return {
			ok: false,
			response: validationError('speech_model', 'Input should be a valid string', speechModel)
		};
	}
	const transcriptionExtraBody = optionalRecord(value, 'transcription_extra_body');
	if (!transcriptionExtraBody.ok) return transcriptionExtraBody;
	const speechExtraBody = optionalRecord(value, 'speech_extra_body');
	if (!speechExtraBody.ok) return speechExtraBody;

	return {
		ok: true,
		value: {
			body: structuredClone(value),
			stream,
			wantsAudio,
			...(audio === undefined ? {} : { audio }),
			transcriptionModel,
			transcriptionExtraBody: transcriptionExtraBody.value,
			speechModel,
			speechExtraBody: speechExtraBody.value
		}
	};
}

function decodeBase64(value: string): Uint8Array {
	const bytes = Buffer.from(value, 'base64');
	const normalisedInput = value.replace(/\s/g, '').replace(/=+$/, '');
	const normalisedOutput = bytes.toString('base64').replace(/=+$/, '');
	if (bytes.byteLength === 0 || normalisedInput !== normalisedOutput) {
		throw new APIProxyError('Input audio contains invalid base64 data', { status: 422 });
	}
	return bytes;
}

function cachedTranscript(id: string): string | undefined {
	const entry = audioTranscripts.get(id);
	if (entry === undefined) return undefined;
	if (entry.expiresAt <= Date.now()) {
		audioTranscripts.delete(id);
		return undefined;
	}
	return entry.transcript;
}

function cacheTranscript(id: string, transcript: string, expiresAt: number): void {
	while (audioTranscripts.size >= AUDIO_TRANSCRIPTION_CACHE_SIZE) {
		const oldest = audioTranscripts.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		audioTranscripts.delete(oldest);
	}
	audioTranscripts.set(id, { transcript, expiresAt });
}

async function transcribeInputAudio(
	request: ParsedRequest,
	runtime: ChatRuntime,
	signal: AbortSignal
) {
	const messages = request.body.messages as unknown[];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
		const message = messages[messageIndex];
		if (!isRecord(message) || typeof message.role !== 'string') {
			throw new APIProxyError(`Invalid chat message at index ${messageIndex}`, { status: 422 });
		}
		if (message.role === 'user' && Array.isArray(message.content)) {
			for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
				const part = message.content[partIndex];
				if (!isRecord(part) || part.type !== 'input_audio') continue;
				if (
					!isRecord(part.input_audio) ||
					typeof part.input_audio.data !== 'string' ||
					typeof part.input_audio.format !== 'string'
				) {
					throw new APIProxyError(`Invalid input audio at message ${messageIndex}`, {
						status: 422
					});
				}
				const transcript = await runtime.transcribe(
					decodeBase64(part.input_audio.data),
					part.input_audio.format,
					request.transcriptionModel,
					request.transcriptionExtraBody,
					signal
				);
				message.content[partIndex] = { type: 'text', text: transcript };
			}
		} else if (message.role === 'assistant' && isRecord(message.audio)) {
			const audioId = message.audio.id;
			if (typeof audioId !== 'string') continue;
			const transcript = cachedTranscript(audioId);
			if (transcript === undefined) {
				throw new APIProxyError(`Audio transcript '${audioId}' is missing or expired`, {
					status: 400
				});
			}
			messages[messageIndex] = { ...message, content: transcript, audio: undefined };
		}
	}
}

function backendBody(request: ParsedRequest): JsonObject {
	const body = structuredClone(request.body);
	body.modalities = ['text'];
	delete body.audio;
	delete body.transcription_model;
	delete body.transcription_extra_body;
	delete body.speech_model;
	delete body.speech_extra_body;
	return body;
}

async function responseFailure(response: Response, operation: string): Promise<never> {
	const text = await response.text().catch(() => '');
	let detail: unknown;
	try {
		detail = JSON.parse(text);
	} catch {
		detail = text;
	}
	throw new APIProxyError(`${operation} failed`, { status: response.status, debug: detail });
}

function choicesOf(completion: JsonObject): JsonObject[] {
	if (!Array.isArray(completion.choices)) {
		throw new APIProxyError('Chat backend returned an invalid completion', { debug: completion });
	}
	return completion.choices.filter(isRecord);
}

async function nonStreamingResponse(
	completion: JsonObject,
	request: ParsedRequest,
	runtime: ChatRuntime,
	signal: AbortSignal
): Promise<Response> {
	const choices = choicesOf(completion);
	for (const choice of choices) {
		if (!isRecord(choice.message)) {
			throw new APIProxyError('Chat backend returned an invalid message', { debug: choice });
		}
		if (!request.wantsAudio) {
			choice.message.audio = null;
			continue;
		}
		const transcript = choice.message.content;
		if (typeof transcript !== 'string') continue;
		const speech = await runtime.speak(
			transcript,
			request.speechModel,
			request.audio!,
			request.speechExtraBody,
			signal
		);
		if (!speech.ok) await responseFailure(speech, 'Speech synthesis');
		const audioId = `audio_${randomUUID()}`;
		const expiresAt = Date.now() + AUDIO_TRANSCRIPTION_TTL_MS;
		cacheTranscript(audioId, transcript, expiresAt);
		choice.message.content = null;
		choice.message.audio = {
			id: audioId,
			data: Buffer.from(await speech.arrayBuffer()).toString('base64'),
			transcript,
			expires_at: Math.floor(expiresAt / 1000)
		};
	}
	return Response.json(completion);
}

function streamingResponse(
	chunks: AsyncIterable<JsonObject>,
	request: ParsedRequest,
	runtime: ChatRuntime,
	controller: AbortController,
	dispose: () => void
): Response {
	const encoder = new TextEncoder();
	const chunker = new SentenceChunker();
	const audioId = `audio_${randomUUID()}`;
	const expiresAt = Date.now() + AUDIO_TRANSCRIPTION_TTL_MS;
	let transcript = '';
	let metadataResolved = false;
	let resolveMetadata!: (value: { id: string; created: number }) => void;
	const metadata = new Promise<{ id: string; created: number }>((resolve) => {
		resolveMetadata = resolve;
	});

	const body = new ReadableStream<Uint8Array>({
		start(streamController) {
			let finished = false;
			const enqueue = (chunk: JsonObject) => {
				if (!finished) streamController.enqueue(encoder.encode(formatAsSse(JSON.stringify(chunk))));
			};
			const textProducer = async () => {
				try {
					for await (const sourceChunk of chunks) {
						if (controller.signal.aborted) throw controller.signal.reason;
						const chunk = structuredClone(sourceChunk);
						const choices = choicesOf(chunk);
						if (choices.length === 0) continue;
						if (!metadataResolved) {
							metadataResolved = true;
							resolveMetadata({
								id: typeof chunk.id === 'string' ? chunk.id : `chatcmpl-${randomUUID()}`,
								created:
									typeof chunk.created === 'number' ? chunk.created : Math.floor(Date.now() / 1000)
							});
						}
						const choice = choices[0]!;
						if (!isRecord(choice.delta)) choice.delta = {};
						const delta = choice.delta as JsonObject;
						const content = typeof delta.content === 'string' ? delta.content : '';
						if (request.wantsAudio) {
							if (content.length > 0) {
								transcript += content;
								chunker.addToken(content);
							}
							delta.content = null;
							delta.audio = {
								id: audioId,
								transcript: content,
								expires_at: Math.floor(expiresAt / 1000)
							};
						} else {
							delete delta.audio;
						}
						enqueue(chunk);
					}
				} finally {
					if (!metadataResolved) {
						metadataResolved = true;
						resolveMetadata({
							id: `chatcmpl-${randomUUID()}`,
							created: Math.floor(Date.now() / 1000)
						});
					}
					chunker.close();
				}
			};

			const audioProducer = async () => {
				if (!request.wantsAudio) return;
				const completion = await metadata;
				for await (const sentence of chunker) {
					if (controller.signal.aborted) throw controller.signal.reason;
					const speech = await runtime.speak(
						sentence,
						request.speechModel,
						request.audio!,
						request.speechExtraBody,
						controller.signal
					);
					if (!speech.ok) await responseFailure(speech, 'Speech synthesis');
					if (speech.body === null) continue;
					const reader = speech.body.getReader();
					try {
						for (;;) {
							const next = await reader.read();
							if (next.done) break;
							enqueue({
								id: completion.id,
								object: 'chat.completion.chunk',
								created: completion.created,
								model: request.speechModel,
								choices: [
									{
										index: 0,
										delta: {
											content: null,
											audio: {
												id: audioId,
												data: Buffer.from(next.value).toString('base64'),
												expires_at: Math.floor(expiresAt / 1000)
											}
										},
										finish_reason: null
									}
								]
							});
						}
					} finally {
						reader.releaseLock();
					}
				}
				cacheTranscript(audioId, transcript, expiresAt);
			};

			void Promise.all([textProducer(), audioProducer()]).then(
				() => {
					finished = true;
					dispose();
					streamController.close();
				},
				(error: unknown) => {
					finished = true;
					controller.abort(error);
					dispose();
					streamController.error(error);
				}
			);
		},
		cancel(reason) {
			dispose();
			controller.abort(reason ?? new Error('Chat response stream cancelled'));
		}
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache'
		}
	});
}

export async function createChatResponse(
	body: unknown,
	signal: AbortSignal,
	runtime: ChatRuntime = createNativeChatRuntime()
): Promise<Response> {
	const parsed = parseRequest(body);
	if (!parsed.ok) return parsed.response;
	const controller = new AbortController();
	const forwardAbort = () => controller.abort(signal.reason);
	const dispose = () => signal.removeEventListener('abort', forwardAbort);
	if (signal.aborted) forwardAbort();
	else signal.addEventListener('abort', forwardAbort, { once: true });
	try {
		await transcribeInputAudio(parsed.value, runtime, controller.signal);
		const result = await runtime.complete(backendBody(parsed.value), controller.signal);
		if (parsed.value.stream) {
			if (!result.stream) {
				throw new APIProxyError('Chat backend returned a non-streaming response');
			}
			return streamingResponse(result.chunks, parsed.value, runtime, controller, dispose);
		}
		if (result.stream) throw new APIProxyError('Chat backend returned a streaming response');
		const response = await nonStreamingResponse(
			result.completion,
			parsed.value,
			runtime,
			controller.signal
		);
		dispose();
		return response;
	} catch (error) {
		dispose();
		throw error;
	}
}

function contentTypeForAudio(format: string): string {
	return format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
}

function extraFormFields(form: FormData, extraBody: JsonObject | undefined): void {
	if (extraBody === undefined) return;
	for (const [key, value] of Object.entries(extraBody)) {
		if (key === 'file' || key === 'model' || key === 'response_format') continue;
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			form.set(key, String(value));
		}
	}
}

export function createNativeChatRuntime(): ChatRuntime {
	return {
		async complete(body, signal) {
			const config = getConfig();
			const target = new URL(
				'chat/completions',
				`${config.chatCompletionBaseUrl.replace(/\/?$/, '/')}`
			);
			let response: Response;
			try {
				response = await fetch(target, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${config.chatCompletionApiKey}`
					},
					body: JSON.stringify(body),
					signal
				});
			} catch (error) {
				if (signal.aborted) throw signal.reason;
				throw new APIProxyError('Failed to communicate with the language model API', {
					status: 502,
					hint: 'Verify the chat backend URL and API key.',
					debug: error
				});
			}
			if (!response.ok) await responseFailure(response, 'Language model request');
			if (body.stream === true) {
				if (response.body === null) {
					throw new APIProxyError('Chat backend returned an empty stream');
				}
				return {
					stream: true,
					chunks: (async function* () {
						for await (const data of parseSseStream(response.body!, signal)) {
							const chunk: unknown = JSON.parse(data);
							if (!isRecord(chunk)) {
								throw new APIProxyError('Chat backend returned an invalid stream chunk');
							}
							yield chunk;
						}
					})()
				};
			}
			const completion: unknown = await response.json();
			if (!isRecord(completion)) {
				throw new APIProxyError('Chat backend returned an invalid completion');
			}
			return { stream: false, completion };
		},

		async transcribe(data, format, model, extraBody, signal) {
			const form = new FormData();
			form.set('model', model);
			form.set('response_format', 'text');
			form.set(
				'file',
				new Blob([Uint8Array.from(data).buffer], { type: contentTypeForAudio(format) }),
				`input.${format}`
			);
			extraFormFields(form, extraBody);
			const response = await createTranscriptionResponse(
				form,
				signal,
				getTranscriptionExecutors(),
				undefined,
				getVadExecutor()
			);
			if (!response.ok) await responseFailure(response, 'Audio transcription');
			return response.text();
		},

		async speak(text, model, audio, extraBody, signal) {
			return createSpeechResponse(
				{
					model,
					voice: audio.voice,
					input: text,
					response_format: audio.format === 'pcm16' ? 'pcm' : audio.format,
					sample_rate: typeof extraBody?.sample_rate === 'number' ? extraBody.sample_rate : 24_000
				},
				signal,
				getSpeechExecutors()
			);
		}
	};
}

export function invalidChatJsonResponse(): Response {
	return validationError('body', 'Expected a JSON request body', null);
}
