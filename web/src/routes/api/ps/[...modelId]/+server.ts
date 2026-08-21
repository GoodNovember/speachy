import type { RequestHandler } from './$types';
import { APIProxyError } from '$lib/server/errors';
import { getInferenceWorker } from '$lib/server/executors/python-runtime';
import { PythonWorkerError, type ModelLifecycleResult } from '$lib/server/executors/python-worker';

type ModelLifecycleClient = {
	loadModel(modelId: string, options?: { signal?: AbortSignal }): Promise<ModelLifecycleResult>;
	unloadModel(modelId: string, options?: { signal?: AbortSignal }): Promise<ModelLifecycleResult>;
};

function workerError(error: unknown): PythonWorkerError | undefined {
	if (error instanceof PythonWorkerError) return error;
	if (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		'message' in error &&
		typeof error.code === 'string' &&
		typeof error.message === 'string'
	) {
		return new PythonWorkerError({ code: error.code, message: error.message });
	}
	return undefined;
}

function unexpectedWorkerError(error: unknown): never {
	const structured = workerError(error);
	throw new APIProxyError('Python inference worker request failed.', {
		hint: 'Verify that the configured Python environment can start the Speachy inference worker.',
		suggestions: [
			'Set SPEACHY_PYTHON to the Python executable from the synced project environment.',
			'Check the server log for the worker error.'
		],
		debug: structured === undefined ? error : { code: structured.code, message: structured.message }
	});
}

export async function _loadModelResponse(
	modelId: string,
	worker: ModelLifecycleClient,
	signal?: AbortSignal
): Promise<Response> {
	try {
		await worker.loadModel(modelId, { signal });
		return Response.json({ message: `Model '${modelId}' loaded.` }, { status: 201 });
	} catch (error) {
		const structured = workerError(error);
		if (structured?.code === 'model_already_loaded') {
			return Response.json({ message: `Model '${modelId}' is already loaded.` }, { status: 409 });
		}
		if (structured?.code === 'model_not_available') {
			return Response.json({ message: `Model '${modelId}' not supported.` }, { status: 404 });
		}
		unexpectedWorkerError(error);
	}
}

export async function _unloadModelResponse(
	modelId: string,
	worker: ModelLifecycleClient,
	signal?: AbortSignal
): Promise<Response> {
	try {
		await worker.unloadModel(modelId, { signal });
		return Response.json({ message: `Model ${modelId} unloaded.` });
	} catch (error) {
		const structured = workerError(error);
		if (structured?.code === 'model_not_loaded') {
			return Response.json({ message: `Model ${modelId} is not loaded.` }, { status: 404 });
		}
		if (structured?.code === 'model_in_use') {
			return Response.json({ message: structured.message }, { status: 409 });
		}
		unexpectedWorkerError(error);
	}
}

export const POST: RequestHandler = async ({ params, request }) => {
	return _loadModelResponse(params.modelId, await getInferenceWorker(), request.signal);
};

export const DELETE: RequestHandler = async ({ params, request }) => {
	return _unloadModelResponse(params.modelId, await getInferenceWorker(), request.signal);
};
