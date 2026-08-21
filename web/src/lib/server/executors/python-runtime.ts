import { getRuntime, type Runtime } from '../runtime.ts';
import { PythonWorkerClient, type PythonWorkerOptions, type WorkerPing } from './python-worker.ts';

export const PYTHON_WORKER_PROTOCOL_VERSION = 1;

export type PythonWorkerFactory = (options: PythonWorkerOptions) => PythonWorkerClient;

const createWorker: PythonWorkerFactory = (options) => new PythonWorkerClient(options);

export async function startInferenceWorker(
	runtime: Runtime,
	factory: PythonWorkerFactory = createWorker
): Promise<PythonWorkerClient> {
	if (runtime.inferenceWorker !== undefined) return runtime.inferenceWorker;
	if (runtime.inferenceWorkerStart !== undefined) return runtime.inferenceWorkerStart;

	const worker = factory({
		env: {
			...process.env,
			SPEACHY_INFERENCE_WORKERS: String(runtime.config.inferenceWorkers)
		}
	});
	const starting = worker
		.ping()
		.then((ping: WorkerPing) => {
			if (ping.protocol_version !== PYTHON_WORKER_PROTOCOL_VERSION) {
				throw new Error(
					`Unsupported Python worker protocol ${ping.protocol_version}; expected ${PYTHON_WORKER_PROTOCOL_VERSION}`
				);
			}
			runtime.inferenceWorker = worker;
			return worker;
		})
		.catch(async (error: unknown) => {
			await worker.close();
			throw error;
		})
		.finally(() => {
			if (runtime.inferenceWorkerStart === starting) delete runtime.inferenceWorkerStart;
		});

	runtime.inferenceWorkerStart = starting;
	return starting;
}

export function getInferenceWorker(): Promise<PythonWorkerClient> {
	return startInferenceWorker(getRuntime());
}

export async function closeInferenceWorker(runtime: Runtime = getRuntime()): Promise<void> {
	let worker = runtime.inferenceWorker;
	if (worker === undefined && runtime.inferenceWorkerStart !== undefined) {
		try {
			worker = await runtime.inferenceWorkerStart;
		} catch {
			// A failed start already closes its child process.
		}
	}
	delete runtime.inferenceWorker;
	delete runtime.inferenceWorkerStart;
	await worker?.close();
}
