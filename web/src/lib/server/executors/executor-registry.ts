import { loadConfig, type Config } from '../config.ts';
import { getConfig, hasRuntime } from '../runtime.ts';
import { getInferenceWorker } from './python-runtime.ts';
import { PythonDiarizationExecutor } from './python-diarization.ts';
import { PythonSpeakerEmbeddingExecutor } from './python-speaker-embedding.ts';
import { PythonSpeechExecutor } from './python-speech.ts';
import { PythonTranscriptionExecutor } from './python-transcription.ts';
import { SherpaParakeetTranscriptionExecutor } from './sherpa-parakeet-transcription.ts';
import { SherpaWhisperTranscriptionExecutor } from './sherpa-transcription.ts';
import { SileroVadExecutor } from './silero-vad.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type {
	DiarizationExecutor,
	ExecutorBase,
	SpeakerEmbeddingExecutor,
	SpeechExecutor,
	TranscriptionExecutor,
	VadExecutor
} from './types.ts';

const nativeVadExecutor = new SileroVadExecutor();
let nativeWhisperExecutor: SherpaWhisperTranscriptionExecutor | undefined;
let nativeParakeetExecutor: SherpaParakeetTranscriptionExecutor | undefined;

const lazyPythonWorker = {
	async request(
		method: string,
		params: Record<string, unknown>,
		options?: PythonWorkerRequestOptions
	): Promise<unknown> {
		return (await getInferenceWorker()).request(method, params, options);
	}
};

export async function findExecutorForModel<T extends ExecutorBase>(
	modelId: string,
	executors: readonly T[]
): Promise<T | undefined> {
	for (const executor of executors) {
		if (await executor.canHandle(modelId)) return executor;
	}
	return undefined;
}

function config(): Config {
	return hasRuntime() ? getConfig() : loadConfig(process.env);
}

function nativeTranscriptions(): readonly TranscriptionExecutor[] {
	nativeWhisperExecutor ??= new SherpaWhisperTranscriptionExecutor({
		workerCount: config().inferenceWorkers
	});
	nativeParakeetExecutor ??= new SherpaParakeetTranscriptionExecutor({
		workerCount: config().inferenceWorkers
	});
	return [nativeWhisperExecutor, nativeParakeetExecutor];
}

export function composeTranscriptionExecutors(
	backend: Config['inferenceBackend'],
	nativeExecutors: readonly TranscriptionExecutor[],
	pythonExecutor: TranscriptionExecutor
): readonly TranscriptionExecutor[] {
	if (backend === 'native') return nativeExecutors;
	if (backend === 'python') return [pythonExecutor];
	return [...nativeExecutors, pythonExecutor];
}

// This is the composition boundary for native routes. Route files depend only
// on executor interfaces; concrete Python adapters stay contained here and can
// be replaced by worker-thread implementations in Phase 4.
export function getSpeakerEmbeddingExecutors(): readonly SpeakerEmbeddingExecutor[] {
	if (config().inferenceBackend === 'native') return [];
	return [new PythonSpeakerEmbeddingExecutor(lazyPythonWorker)];
}

export function getDiarizationExecutors(): readonly DiarizationExecutor[] {
	if (config().inferenceBackend === 'native') return [];
	return [new PythonDiarizationExecutor(lazyPythonWorker)];
}

export function getTranscriptionExecutors(): readonly TranscriptionExecutor[] {
	return composeTranscriptionExecutors(
		config().inferenceBackend,
		nativeTranscriptions(),
		new PythonTranscriptionExecutor(lazyPythonWorker)
	);
}

export function getTranslationExecutors(): readonly TranscriptionExecutor[] {
	if (config().inferenceBackend === 'native') return [];
	return [new PythonTranscriptionExecutor(lazyPythonWorker)];
}

export function getSpeechExecutors(): readonly SpeechExecutor[] {
	if (config().inferenceBackend === 'native') return [];
	return [new PythonSpeechExecutor(lazyPythonWorker)];
}

export function getVadExecutor(): VadExecutor {
	return nativeVadExecutor;
}
