import type { RequestHandler } from './$types';
import { getInferenceWorker } from '$lib/server/executors/python-runtime';
import type { LoadedModels } from '$lib/server/executors/python-worker';

type LoadedModelsClient = {
	listLoaded(options?: { signal?: AbortSignal }): Promise<LoadedModels>;
};

export async function _loadedModelsResponse(
	worker: LoadedModelsClient,
	signal?: AbortSignal
): Promise<Response> {
	return Response.json(await worker.listLoaded({ signal }));
}

export const GET: RequestHandler = async ({ request }) => {
	return _loadedModelsResponse(await getInferenceWorker(), request.signal);
};
