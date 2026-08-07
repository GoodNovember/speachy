// This is the seam that keeps the port's phases cheap. A Python RPC client and
// a sherpa-onnx worker are both just implementations of these interfaces, so
// swapping one for the other is a new file, not a refactor. Nothing outside
// this directory may import a concrete executor.

export type ModelTask =
	| 'automatic-speech-recognition'
	| 'text-to-speech'
	| 'voice-activity-detection'
	| 'speaker-embedding'
	| 'speaker-diarization';

export type Audio = {
	data: Float32Array;
	sampleRate: number;
	name?: string;
};

export type Model = {
	id: string;
	created: number;
	ownedBy: string;
	task: ModelTask;
	language?: string[];
};

export type ResponseFormat = 'text' | 'json' | 'verbose_json' | 'srt' | 'vtt';
export type TimestampGranularity = 'segment' | 'word';

export type VadOptions = {
	threshold: number;
	negThreshold?: number;
	minSpeechDurationMs: number;
	maxSpeechDurationS: number;
	minSilenceDurationMs: number;
	speechPadMs: number;
};

export type SpeechTimestamp = {
	start: number;
	end: number;
};

export type TranscriptionSegment = {
	id: number;
	start: number;
	end: number;
	text: string;
	words?: TranscriptionWord[];
};

export type TranscriptionWord = {
	word: string;
	start: number;
	end: number;
};

export type Transcription = {
	text: string;
	language?: string;
	duration?: number;
	segments?: TranscriptionSegment[];
	words?: TranscriptionWord[];
};

export type TranscriptionDelta = { type: 'delta'; delta: string };
export type TranscriptionDone = { type: 'done'; text: string };
export type TranscriptionEvent = TranscriptionDelta | TranscriptionDone;

export type TranscriptionRequest = {
	audio: Audio;
	model: string;
	language?: string;
	prompt?: string;
	responseFormat: ResponseFormat;
	temperature: number;
	timestampGranularities: TimestampGranularity[];
	speechSegments: SpeechTimestamp[];
	vadOptions: VadOptions;
	hotwords?: string;
	withoutTimestamps: boolean;
};

export type TranslationRequest = {
	audio: Audio;
	model: string;
	prompt?: string;
	responseFormat: ResponseFormat;
	temperature: number;
	speechSegments: SpeechTimestamp[];
	vadOptions: VadOptions;
};

export type SpeechRequest = {
	model: string;
	voice: string;
	text: string;
	speed: number;
};

export type VadRequest = {
	audio: Audio;
	modelId: string;
	vadOptions: VadOptions;
};

export type SpeakerEmbeddingRequest = {
	audio: Audio;
	modelId: string;
};

export type DiarizationSegment = {
	start: number;
	end: number;
	speaker: string;
};

export type DiarizationRequest = {
	audio: Audio;
	modelId: string;
	numSpeakers?: number;
};

// Every method takes an AbortSignal. The Python original cancels through
// asyncio task groups; in Node, threading a signal from the socket down to the
// worker is the only way a hung-up caller actually stops inference.

export type ExecutorBase = {
	readonly name: string;
	readonly task: ModelTask;
	listLocalModels(): Promise<Model[]>;
	listRemoteModels(): Promise<Model[]>;
	canHandle(modelId: string): Promise<boolean>;
};

export type TranscriptionExecutor = ExecutorBase & {
	readonly task: 'automatic-speech-recognition';
	transcribe(request: TranscriptionRequest, signal: AbortSignal): Promise<Transcription>;
	transcribeStream(
		request: TranscriptionRequest,
		signal: AbortSignal
	): AsyncIterable<TranscriptionEvent>;
	translate?(request: TranslationRequest, signal: AbortSignal): Promise<Transcription>;
};

export type SpeechExecutor = ExecutorBase & {
	readonly task: 'text-to-speech';
	synthesize(request: SpeechRequest, signal: AbortSignal): AsyncIterable<Audio>;
	listVoices(modelId: string): Promise<string[]>;
};

export type VadExecutor = ExecutorBase & {
	readonly task: 'voice-activity-detection';
	detectSpeech(request: VadRequest, signal: AbortSignal): Promise<SpeechTimestamp[]>;
};

export type SpeakerEmbeddingExecutor = ExecutorBase & {
	readonly task: 'speaker-embedding';
	embed(request: SpeakerEmbeddingRequest, signal: AbortSignal): Promise<Float32Array>;
};

export type DiarizationExecutor = ExecutorBase & {
	readonly task: 'speaker-diarization';
	diarize(request: DiarizationRequest, signal: AbortSignal): Promise<DiarizationSegment[]>;
};

export type AnyExecutor =
	| TranscriptionExecutor
	| SpeechExecutor
	| VadExecutor
	| SpeakerEmbeddingExecutor
	| DiarizationExecutor;

export type ExecutorRegistry = {
	transcription: readonly TranscriptionExecutor[];
	translation: readonly TranscriptionExecutor[];
	textToSpeech: readonly SpeechExecutor[];
	speakerEmbedding: readonly SpeakerEmbeddingExecutor[];
	diarization: readonly DiarizationExecutor[];
	vad: VadExecutor;
	all(): readonly AnyExecutor[];
	downloadModelById(modelId: string): Promise<boolean>;
};
