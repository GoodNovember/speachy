import type {
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming
} from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { audioBytes, models, openai, serverIsUp } from './helpers.ts';

// Ported from tests/api_chat_test.py. The Python suite also targets the real
// OpenAI API; this contract suite deliberately targets Speachy only.

const CHAT_BACKEND_BASE_URL =
	process.env.SPEACHY_CHAT_BASE_URL ??
	process.env.CHAT_COMPLETION_BASE_URL ??
	'http://127.0.0.1:11434/v1';
const CHAT_BACKEND_API_KEY =
	process.env.SPEACHY_CHAT_API_KEY ?? process.env.CHAT_COMPLETION_API_KEY ?? 'cant-be-empty';

async function discoverChatModel(): Promise<string | undefined> {
	if (process.env.SPEACHY_CHAT_MODEL) return process.env.SPEACHY_CHAT_MODEL;

	try {
		const response = await fetch(`${CHAT_BACKEND_BASE_URL.replace(/\/$/, '')}/models`, {
			headers: { authorization: `Bearer ${CHAT_BACKEND_API_KEY}` },
			signal: AbortSignal.timeout(3000)
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: { id?: string }[] };
		const ids = body.data?.flatMap((model) => (model.id ? [model.id] : [])) ?? [];
		return ids.find((id) => id === 'llama3.2:latest') ?? ids.find((id) => !id.includes('embed'));
	} catch {
		return undefined;
	}
}

type SpeachyChatFields = {
	transcription_model: string;
	speech_model?: string;
};

function expectChoiceIndexes(choices: { index: number }[]): void {
	expect(choices).toHaveLength(1);
	expect(choices[0]?.index).toBe(0);
}

function expectNonStreamingCompletion(completion: ChatCompletion, wantsAudio: boolean): void {
	expectChoiceIndexes(completion.choices);
	const choice = completion.choices[0]!;
	expect(choice.finish_reason).toBe('stop');

	if (wantsAudio) {
		expect(choice.message.content).toBeNull();
		expect(choice.message.audio?.id).toBeTypeOf('string');
		expect(choice.message.audio?.transcript).toBeTypeOf('string');
		expect(choice.message.audio?.transcript.length).toBeGreaterThan(0);
		expect(choice.message.audio?.data).toBeTypeOf('string');
		expect(choice.message.audio?.data.length).toBeGreaterThan(0);
	} else {
		expect(choice.message.content).toBeTypeOf('string');
		expect(choice.message.content?.length).toBeGreaterThan(0);
		expect(choice.message.audio).toBeNull();
	}
}

function expectStreamingCompletion(chunks: ChatCompletionChunk[], wantsAudio: boolean): void {
	expect(chunks.length).toBeGreaterThan(0);
	expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
	for (const chunk of chunks) expectChoiceIndexes(chunk.choices);

	if (wantsAudio) {
		for (const chunk of chunks) expect(chunk.choices[0]?.delta.content).toBeNull();
		const audioDeltas = chunks.flatMap((chunk) => {
			const audio = (chunk.choices[0]?.delta as { audio?: { data?: string; id?: string } }).audio;
			return audio?.data ? [audio] : [];
		});
		expect(audioDeltas.length).toBeGreaterThan(0);
		expect(new Set(audioDeltas.map((audio) => audio.id)).size).toBe(1);
		expect(
			audioDeltas.reduce((size, audio) => size + Buffer.from(audio.data!, 'base64').length, 0)
		).toBeGreaterThan(0);
	} else {
		for (const chunk of chunks) expect('audio' in chunk.choices[0]!.delta).toBe(false);
		expect(chunks.some((chunk) => (chunk.choices[0]?.delta.content?.length ?? 0) > 0)).toBe(true);
	}
}

const up = await serverIsUp();
const chatModel = up ? await discoverChatModel() : undefined;
const discovered = up ? await models() : {};
const transcriptionModel = discovered.transcription;
const speechModel = discovered.speech;
const voice = discovered.voice;
const canTestText = up && chatModel !== undefined && transcriptionModel !== undefined;
const canTestAudio = canTestText && speechModel !== undefined && voice !== undefined;

async function inputAudio(): Promise<string> {
	return Buffer.from(await audioBytes()).toString('base64');
}

function messages(audio: string) {
	return [
		{
			role: 'user' as const,
			content: [
				{ type: 'text' as const, text: 'What is in this recording? Answer in one short sentence.' },
				{ type: 'input_audio' as const, input_audio: { data: audio, format: 'wav' as const } }
			]
		}
	];
}

describe.skipIf(!canTestText)('audio chat contract', () => {
	it('returns a non-streaming text reply for audio input', async () => {
		const body = {
			model: chatModel!,
			modalities: ['text'],
			audio: { voice: voice ?? 'alloy', format: 'wav' },
			stream: false,
			messages: messages(await inputAudio()),
			transcription_model: transcriptionModel!
		} as ChatCompletionCreateParamsNonStreaming & SpeachyChatFields;
		const completion = await openai.chat.completions.create(body);
		expectNonStreamingCompletion(completion, false);
	}, 120_000);

	it.skipIf(!canTestAudio)(
		'returns a non-streaming spoken reply for audio input',
		async () => {
			const body = {
				model: chatModel!,
				modalities: ['text', 'audio'],
				audio: { voice: voice!, format: 'wav' },
				stream: false,
				messages: messages(await inputAudio()),
				transcription_model: transcriptionModel!,
				speech_model: speechModel!
			} as ChatCompletionCreateParamsNonStreaming & SpeachyChatFields;
			const completion = await openai.chat.completions.create(body);
			expectNonStreamingCompletion(completion, true);
		},
		120_000
	);

	it('streams a text reply for audio input', async () => {
		const body = {
			model: chatModel!,
			modalities: ['text'],
			audio: { voice: voice ?? 'alloy', format: 'pcm16' },
			stream: true,
			messages: messages(await inputAudio()),
			transcription_model: transcriptionModel!
		} as ChatCompletionCreateParamsStreaming & SpeachyChatFields;
		const chunks: ChatCompletionChunk[] = [];
		for await (const chunk of await openai.chat.completions.create(body)) chunks.push(chunk);
		expectStreamingCompletion(chunks, false);
	}, 120_000);

	it.skipIf(!canTestAudio)(
		'streams a spoken reply for audio input',
		async () => {
			const body = {
				model: chatModel!,
				modalities: ['text', 'audio'],
				audio: { voice: voice!, format: 'pcm16' },
				stream: true,
				messages: messages(await inputAudio()),
				transcription_model: transcriptionModel!,
				speech_model: speechModel!
			} as ChatCompletionCreateParamsStreaming & SpeachyChatFields;
			const chunks: ChatCompletionChunk[] = [];
			for await (const chunk of await openai.chat.completions.create(body)) chunks.push(chunk);
			expectStreamingCompletion(chunks, true);
		},
		120_000
	);
});
