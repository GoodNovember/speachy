import { getInferenceWorker } from './python-runtime.ts';
import { PythonDiarizationExecutor } from './python-diarization.ts';
import { PythonSpeakerEmbeddingExecutor } from './python-speaker-embedding.ts';
import { PythonTranscriptionExecutor } from './python-transcription.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type {
	DiarizationExecutor,
	ExecutorBase,
	SpeakerEmbeddingExecutor,
	TranscriptionExecutor
} from './types.ts';

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

// This is the composition boundary for native routes. Route files depend only
// on executor interfaces; concrete Python adapters stay contained here and can
// be replaced by worker-thread implementations in Phase 4.
export function getSpeakerEmbeddingExecutors(): readonly SpeakerEmbeddingExecutor[] {
	return [new PythonSpeakerEmbeddingExecutor(lazyPythonWorker)];
}

export function getDiarizationExecutors(): readonly DiarizationExecutor[] {
	return [new PythonDiarizationExecutor(lazyPythonWorker)];
}

export function getTranscriptionExecutors(): readonly TranscriptionExecutor[] {
	return [new PythonTranscriptionExecutor(lazyPythonWorker)];
}

export function getTranslationExecutors(): readonly TranscriptionExecutor[] {
	return [new PythonTranscriptionExecutor(lazyPythonWorker)];
}
