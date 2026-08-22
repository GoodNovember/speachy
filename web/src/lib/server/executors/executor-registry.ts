import { getInferenceWorker } from './python-runtime.ts';
import { PythonSpeakerEmbeddingExecutor } from './python-speaker-embedding.ts';
import type { PythonWorkerRequestOptions } from './python-worker.ts';
import type { ExecutorBase, SpeakerEmbeddingExecutor } from './types.ts';

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
	const lazyWorker = {
		async request(
			method: string,
			params: Record<string, unknown>,
			options?: PythonWorkerRequestOptions
		): Promise<unknown> {
			return (await getInferenceWorker()).request(method, params, options);
		}
	};
	return [new PythonSpeakerEmbeddingExecutor(lazyWorker)];
}
