import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import type { Model, SpeechTimestamp, VadExecutor, VadOptions, VadRequest } from './types.ts';

export const SILERO_VAD_MODEL_ID = 'silero_vad_v5';
export const SILERO_SAMPLE_RATE = 16_000;

const WINDOW_SIZE = 512;
const CONTEXT_SIZE = 64;
const ENCODER_WIDTH = 128;
const ENCODER_BATCH_SIZE = 10_000;

type ModelPaths = { encoder: string; decoder: string };
type SileroSessions = { encoder: ort.InferenceSession; decoder: ort.InferenceSession };

function abortIfRequested(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason;
}

export function resolveSileroModelPaths(
	environment: NodeJS.ProcessEnv = process.env,
	workingDirectory = process.cwd()
): ModelPaths {
	const modelDirectory =
		environment.SPEACHY_VAD_MODEL_DIR ?? resolve(workingDirectory, 'models', SILERO_VAD_MODEL_ID);
	return {
		encoder: resolve(modelDirectory, 'silero_encoder_v5.onnx'),
		decoder: resolve(modelDirectory, 'silero_decoder_v5.onnx')
	};
}

function validateOptions(options: VadOptions): void {
	if (options.threshold < 0 || options.threshold > 1) {
		throw new RangeError('threshold must be between 0 and 1');
	}
	if (options.negThreshold !== undefined && options.negThreshold < 0) {
		throw new RangeError('negThreshold must be non-negative');
	}
	if (
		options.minSpeechDurationMs < 0 ||
		options.maxSpeechDurationS < 0 ||
		options.minSilenceDurationMs < 0 ||
		options.speechPadMs < 0
	) {
		throw new RangeError('VAD durations must be non-negative');
	}
}

// Ported from speaches/executors/silero_vad_v5.py. These remain sample indexes;
// the HTTP route is the boundary that converts them to integer milliseconds.
export function speechTimestampsFromProbabilities(
	speechProbabilities: ArrayLike<number>,
	audioLengthSamples: number,
	options: VadOptions,
	samplingRate = SILERO_SAMPLE_RATE
): SpeechTimestamp[] {
	validateOptions(options);
	const minSpeechSamples = (samplingRate * options.minSpeechDurationMs) / 1000;
	const speechPadSamples = (samplingRate * options.speechPadMs) / 1000;
	const maxSpeechSamples =
		samplingRate * options.maxSpeechDurationS - WINDOW_SIZE - 2 * speechPadSamples;
	const minSilenceSamples = (samplingRate * options.minSilenceDurationMs) / 1000;
	const minSilenceSamplesAtMaxSpeech = (samplingRate * 98) / 1000;
	const negativeThreshold = options.negThreshold ?? Math.max(options.threshold - 0.15, 0.01);

	let triggered = false;
	let currentSpeech: Partial<SpeechTimestamp> = {};
	const speeches: SpeechTimestamp[] = [];
	let temporaryEnd = 0;
	let previousEnd = 0;
	let nextStart = 0;

	for (let index = 0; index < speechProbabilities.length; index += 1) {
		const probability = speechProbabilities[index]!;
		const sample = WINDOW_SIZE * index;

		if (probability >= options.threshold && temporaryEnd !== 0) {
			temporaryEnd = 0;
			if (nextStart < previousEnd) nextStart = sample;
		}

		if (probability >= options.threshold && !triggered) {
			triggered = true;
			currentSpeech.start = sample;
			continue;
		}

		if (triggered && sample - currentSpeech.start! > maxSpeechSamples) {
			if (previousEnd !== 0) {
				currentSpeech.end = previousEnd;
				speeches.push(currentSpeech as SpeechTimestamp);
				currentSpeech = {};
				if (nextStart < previousEnd) triggered = false;
				else currentSpeech.start = nextStart;
				previousEnd = 0;
				nextStart = 0;
				temporaryEnd = 0;
			} else {
				currentSpeech.end = sample;
				speeches.push(currentSpeech as SpeechTimestamp);
				currentSpeech = {};
				previousEnd = 0;
				nextStart = 0;
				temporaryEnd = 0;
				triggered = false;
				continue;
			}
		}

		if (probability < negativeThreshold && triggered) {
			if (temporaryEnd === 0) temporaryEnd = sample;
			if (sample - temporaryEnd > minSilenceSamplesAtMaxSpeech) previousEnd = temporaryEnd;
			if (sample - temporaryEnd < minSilenceSamples) continue;
			currentSpeech.end = temporaryEnd;
			if (currentSpeech.end - currentSpeech.start! > minSpeechSamples) {
				speeches.push(currentSpeech as SpeechTimestamp);
			}
			currentSpeech = {};
			previousEnd = 0;
			nextStart = 0;
			temporaryEnd = 0;
			triggered = false;
		}
	}

	if (
		currentSpeech.start !== undefined &&
		audioLengthSamples - currentSpeech.start > minSpeechSamples
	) {
		currentSpeech.end = audioLengthSamples;
		speeches.push(currentSpeech as SpeechTimestamp);
	}

	for (let index = 0; index < speeches.length; index += 1) {
		const speech = speeches[index]!;
		if (index === 0) speech.start = Math.trunc(Math.max(0, speech.start - speechPadSamples));
		if (index !== speeches.length - 1) {
			const nextSpeech = speeches[index + 1]!;
			const silenceDuration = nextSpeech.start - speech.end;
			if (silenceDuration < 2 * speechPadSamples) {
				const halfSilence = Math.floor(silenceDuration / 2);
				speech.end += halfSilence;
				nextSpeech.start = Math.trunc(Math.max(0, nextSpeech.start - halfSilence));
			} else {
				speech.end = Math.trunc(Math.min(audioLengthSamples, speech.end + speechPadSamples));
				nextSpeech.start = Math.trunc(Math.max(0, nextSpeech.start - speechPadSamples));
			}
		} else {
			speech.end = Math.trunc(Math.min(audioLengthSamples, speech.end + speechPadSamples));
		}
	}
	return speeches;
}

function paddedAudio(audio: Float32Array): Float32Array {
	// numpy.pad in the reference adds a full window when already divisible.
	const padding = WINDOW_SIZE - (audio.length % WINDOW_SIZE);
	const output = new Float32Array(audio.length + padding);
	output.set(audio);
	return output;
}

async function inferProbabilities(
	audio: Float32Array,
	sessions: SileroSessions,
	signal: AbortSignal
): Promise<Float32Array> {
	const padded = paddedAudio(audio);
	const windowCount = padded.length / WINDOW_SIZE;
	const encoded = new Float32Array(windowCount * ENCODER_WIDTH);

	for (let batchStart = 0; batchStart < windowCount; batchStart += ENCODER_BATCH_SIZE) {
		abortIfRequested(signal);
		const batchSize = Math.min(ENCODER_BATCH_SIZE, windowCount - batchStart);
		const input = new Float32Array(batchSize * (WINDOW_SIZE + CONTEXT_SIZE));
		for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
			const windowIndex = batchStart + batchIndex;
			const destination = batchIndex * (WINDOW_SIZE + CONTEXT_SIZE);
			if (windowIndex > 0) {
				const contextStart = (windowIndex - 1) * WINDOW_SIZE + WINDOW_SIZE - CONTEXT_SIZE;
				input.set(padded.subarray(contextStart, contextStart + CONTEXT_SIZE), destination);
			}
			const windowStart = windowIndex * WINDOW_SIZE;
			input.set(
				padded.subarray(windowStart, windowStart + WINDOW_SIZE),
				destination + CONTEXT_SIZE
			);
		}
		const result = await sessions.encoder.run({
			input: new ort.Tensor('float32', input, [batchSize, WINDOW_SIZE + CONTEXT_SIZE])
		});
		encoded.set(
			result[sessions.encoder.outputNames[0]!]!.data as Float32Array,
			batchStart * ENCODER_WIDTH
		);
	}

	let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * ENCODER_WIDTH), [
		2,
		1,
		ENCODER_WIDTH
	]);
	const probabilities = new Float32Array(windowCount);
	for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
		abortIfRequested(signal);
		const start = windowIndex * ENCODER_WIDTH;
		const result = await sessions.decoder.run({
			input: new ort.Tensor('float32', encoded.subarray(start, start + ENCODER_WIDTH), [
				1,
				ENCODER_WIDTH
			]),
			state
		});
		probabilities[windowIndex] = Number(result[sessions.decoder.outputNames[0]!]!.data[0]);
		state = result[sessions.decoder.outputNames[1]!]! as ort.Tensor;
	}
	return probabilities;
}

export class SileroVadExecutor implements VadExecutor {
	readonly name = 'silero-vad-onnxruntime-node';
	readonly task = 'voice-activity-detection' as const;
	readonly #paths: ModelPaths;
	#sessions?: Promise<SileroSessions>;

	constructor(paths = resolveSileroModelPaths()) {
		this.#paths = paths;
	}

	async listLocalModels(): Promise<Model[]> {
		if (!existsSync(this.#paths.encoder) || !existsSync(this.#paths.decoder)) return [];
		const info = await stat(this.#paths.encoder);
		return [
			{
				id: SILERO_VAD_MODEL_ID,
				created: Math.trunc(info.mtimeMs / 1000),
				ownedBy: 'snakers4',
				task: this.task
			}
		];
	}

	async listRemoteModels(): Promise<Model[]> {
		return [];
	}

	async canHandle(modelId: string): Promise<boolean> {
		return modelId === SILERO_VAD_MODEL_ID && (await this.listLocalModels()).length === 1;
	}

	async detectSpeech(request: VadRequest, signal: AbortSignal): Promise<SpeechTimestamp[]> {
		if (request.modelId !== SILERO_VAD_MODEL_ID) {
			throw new Error(`Only '${SILERO_VAD_MODEL_ID}' is supported`);
		}
		if (request.audio.sampleRate !== SILERO_SAMPLE_RATE) {
			throw new RangeError(`Silero VAD requires ${SILERO_SAMPLE_RATE} Hz mono audio`);
		}
		abortIfRequested(signal);
		const probabilities = await inferProbabilities(request.audio.data, await this.#load(), signal);
		abortIfRequested(signal);
		return speechTimestampsFromProbabilities(
			probabilities,
			request.audio.data.length,
			request.vadOptions,
			request.audio.sampleRate
		);
	}

	#load(): Promise<SileroSessions> {
		this.#sessions ??= Promise.all([
			ort.InferenceSession.create(this.#paths.encoder),
			ort.InferenceSession.create(this.#paths.decoder)
		]).then(([encoder, decoder]) => ({ encoder, decoder }));
		return this.#sessions;
	}
}
