import { describe, expect, it, vi } from 'vitest';
import { parseSseJson } from '$lib/api/sse';
import type { ChatRuntime } from '$lib/server/chat-http';
import { _chatResponse } from './+server.ts';

function completion(content = 'A short answer.'): Record<string, unknown> {
	return {
		id: 'chatcmpl-fixture',
		object: 'chat.completion',
		created: 123,
		model: 'fixture-chat',
		choices: [
			{
				index: 0,
				finish_reason: 'stop',
				message: { role: 'assistant', content }
			}
		]
	};
}

async function* chunks() {
	yield {
		id: 'chatcmpl-fixture',
		object: 'chat.completion.chunk',
		created: 123,
		model: 'fixture-chat',
		choices: [{ index: 0, delta: { content: 'A short answer.' }, finish_reason: null }]
	};
	yield {
		id: 'chatcmpl-fixture',
		object: 'chat.completion.chunk',
		created: 123,
		model: 'fixture-chat',
		choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
	};
}

function runtime(overrides: Partial<ChatRuntime> = {}): ChatRuntime {
	return {
		complete: async () => ({ stream: false, completion: completion() }),
		transcribe: async () => 'Hello, world.',
		speak: async () => new Response(new Uint8Array([1, 2, 3])),
		...overrides
	};
}

function audioRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: 'fixture-chat',
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What is here?' },
					{
						type: 'input_audio',
						input_audio: { data: Buffer.from([1, 2, 3]).toString('base64'), format: 'wav' }
					}
				]
			}
		],
		transcription_model: 'fixture-stt',
		...overrides
	};
}

describe('POST /v1/chat/completions', () => {
	it('transcribes input audio before forwarding a non-streaming text request', async () => {
		const complete = vi.fn(async (_body: Record<string, unknown>, _signal: AbortSignal) => ({
			stream: false as const,
			completion: completion()
		}));
		const transcribe = vi.fn(async () => 'Hello, world.');
		const response = await _chatResponse(
			audioRequest({ modalities: ['text'] }),
			new AbortController().signal,
			runtime({ complete, transcribe })
		);
		const body = (await response.json()) as {
			choices: { message: { audio: unknown; content: string } }[];
		};
		expect(body.choices[0]!.message).toMatchObject({ content: 'A short answer.', audio: null });
		expect(transcribe).toHaveBeenCalledWith(
			expect.any(Uint8Array),
			'wav',
			'fixture-stt',
			undefined,
			expect.any(AbortSignal)
		);
		const forwarded = complete.mock.calls[0]![0];
		expect(forwarded).toMatchObject({ modalities: ['text'] });
		expect(forwarded).not.toHaveProperty('audio');
		expect(forwarded).not.toHaveProperty('transcription_model');
		expect(forwarded.messages).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What is here?' },
					{ type: 'text', text: 'Hello, world.' }
				]
			}
		]);
	});

	it('attaches synthesized audio to a non-streaming completion', async () => {
		const speak = vi.fn(async () => new Response(new Uint8Array([9, 8, 7])));
		const response = await _chatResponse(
			audioRequest({
				modalities: ['text', 'audio'],
				audio: { voice: 'fixture-voice', format: 'wav' },
				speech_model: 'fixture-tts'
			}),
			new AbortController().signal,
			runtime({ speak })
		);
		const body = (await response.json()) as {
			choices: { message: { content: null; audio: Record<string, unknown> } }[];
		};
		expect(body.choices[0]!.message.content).toBeNull();
		expect(body.choices[0]!.message.audio).toMatchObject({
			id: expect.stringMatching(/^audio_/),
			data: Buffer.from([9, 8, 7]).toString('base64'),
			transcript: 'A short answer.'
		});
		expect(speak).toHaveBeenCalledWith(
			'A short answer.',
			'fixture-tts',
			{ voice: 'fixture-voice', format: 'wav' },
			undefined,
			expect.any(AbortSignal)
		);
	});

	it('streams text chunks without adding audio fields', async () => {
		const response = await _chatResponse(
			audioRequest({ stream: true, modalities: ['text'] }),
			new AbortController().signal,
			runtime({ complete: async () => ({ stream: true, chunks: chunks() }) })
		);
		const events: Record<string, unknown>[] = [];
		for await (const event of parseSseJson(
			response.body!,
			(value) => value as Record<string, unknown>
		)) {
			events.push(event);
		}
		expect(events).toHaveLength(2);
		for (const event of events) {
			const delta = ((event.choices as JsonChoice[])[0]!.delta ?? {}) as Record<string, unknown>;
			expect(delta).not.toHaveProperty('audio');
		}
	});

	it('streams transcript and stable-id PCM audio deltas concurrently', async () => {
		const response = await _chatResponse(
			audioRequest({
				stream: true,
				modalities: ['text', 'audio'],
				audio: { voice: 'fixture-voice', format: 'pcm16' },
				speech_model: 'fixture-tts'
			}),
			new AbortController().signal,
			runtime({
				complete: async () => ({ stream: true, chunks: chunks() }),
				speak: async () => new Response(new Uint8Array([4, 5, 6]))
			})
		);
		const events: Record<string, unknown>[] = [];
		for await (const event of parseSseJson(
			response.body!,
			(value) => value as Record<string, unknown>
		)) {
			events.push(event);
		}
		const deltas = events.map((event) => (event.choices as JsonChoice[])[0]!.delta!);
		for (const delta of deltas) expect(delta.content).toBeNull();
		const audio = deltas.flatMap((delta) =>
			typeof (delta.audio as JsonAudio | undefined)?.data === 'string'
				? [delta.audio as JsonAudio]
				: []
		);
		expect(audio).toHaveLength(1);
		expect(audio[0]!.data).toBe(Buffer.from([4, 5, 6]).toString('base64'));
		expect(new Set(audio.map((value) => value.id)).size).toBe(1);
	});

	it('requires PCM16 for streaming spoken output', async () => {
		const response = await _chatResponse(
			audioRequest({
				stream: true,
				modalities: ['text', 'audio'],
				audio: { voice: 'fixture-voice', format: 'wav' }
			}),
			new AbortController().signal,
			runtime()
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			detail: [{ loc: ['body', 'audio', 'format'] }]
		});
	});

	it('aborts the backend operation when the response consumer cancels', async () => {
		let backendSignal: AbortSignal | undefined;
		async function* stalled(signal: AbortSignal) {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
			yield completion();
		}
		const response = await _chatResponse(
			audioRequest({ stream: true, modalities: ['text'] }),
			new AbortController().signal,
			runtime({
				complete: async (_body, signal) => {
					backendSignal = signal;
					return { stream: true, chunks: stalled(signal) };
				}
			})
		);
		await response.body!.cancel(new Error('consumer left'));
		expect(backendSignal?.aborted).toBe(true);
	});
});

type JsonAudio = { id?: string; data?: string };
type JsonChoice = { delta?: Record<string, unknown> };
