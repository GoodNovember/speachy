import { z } from 'zod';

// Shapes below match the captured reference responses in
// tests/fixtures/python-reference/endpoints.json, not the Python source.
// Where the two disagree the fixture wins.

export const modelTaskSchema = z.enum([
	'automatic-speech-recognition',
	'text-to-speech',
	'voice-activity-detection',
	'speaker-embedding',
	'speaker-diarization'
]);
export type ModelTask = z.infer<typeof modelTaskSchema>;

// `task` and `language` are Speachy extensions, not part of the OpenAI model object.
export const modelSchema = z.looseObject({
	id: z.string(),
	created: z.number(),
	object: z.literal('model').optional(),
	owned_by: z.string(),
	task: modelTaskSchema.optional(),
	// null, not absent, for models with no language list (silero_vad_v5).
	language: z.array(z.string()).nullable().optional()
});
export type Model = z.infer<typeof modelSchema>;

export const listModelsSchema = z.object({ data: z.array(modelSchema) });
export const listAudioModelsSchema = z.object({ models: z.array(modelSchema) });

export const voiceSchema = z.looseObject({
	id: z.string().optional(),
	name: z.string().optional(),
	language: z.string().optional(),
	gender: z.string().optional()
});
export type Voice = z.infer<typeof voiceSchema>;
export const listVoicesSchema = z.object({ voices: z.array(voiceSchema) });

export const runningModelsSchema = z.object({ models: z.array(z.string()) });

export const transcriptionWordSchema = z.object({
	word: z.string(),
	start: z.number(),
	end: z.number()
});

export const transcriptionSegmentSchema = z.looseObject({
	id: z.number(),
	start: z.number(),
	end: z.number(),
	text: z.string(),
	avg_logprob: z.number().optional(),
	compression_ratio: z.number().optional(),
	no_speech_prob: z.number().optional(),
	temperature: z.number().optional(),
	seek: z.number().optional(),
	tokens: z.array(z.number()).optional()
});
export type TranscriptionSegment = z.infer<typeof transcriptionSegmentSchema>;

export const transcriptionSchema = z.looseObject({ text: z.string() });

// Words land at the top level, not nested in segments.
export const verboseTranscriptionSchema = z.looseObject({
	text: z.string(),
	duration: z.number().optional(),
	language: z.string().optional(),
	segments: z.array(transcriptionSegmentSchema).nullable().optional(),
	words: z.array(transcriptionWordSchema).nullable().optional()
});
export type VerboseTranscription = z.infer<typeof verboseTranscriptionSchema>;

export const transcriptionStreamEventSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('transcript.text.delta'), delta: z.string() }),
	// The reference sends text: "" here. Never rely on it; accumulate deltas.
	z.looseObject({ type: z.literal('transcript.text.done'), text: z.string() })
]);
export type TranscriptionStreamEvent = z.infer<typeof transcriptionStreamEventSchema>;

export const speechStreamEventSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('speech.audio.delta'), audio: z.string() }),
	z.looseObject({ type: z.literal('speech.audio.done') })
]);
export type SpeechStreamEvent = z.infer<typeof speechStreamEventSchema>;

// Milliseconds, as integers.
export const speechTimestampSchema = z.object({ start: z.number(), end: z.number() });
export const speechTimestampsSchema = z.array(speechTimestampSchema);
export type SpeechTimestamp = z.infer<typeof speechTimestampSchema>;

export const RESPONSE_FORMATS = ['json', 'text', 'verbose_json', 'srt', 'vtt'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

// pcm is the only format that does not require ffmpeg on the server.
export const SPEECH_FORMATS = ['mp3', 'wav', 'pcm', 'flac', 'opus', 'aac'] as const;
export type SpeechFormat = (typeof SPEECH_FORMATS)[number];
