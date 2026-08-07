import type { RequestHandler } from './$types';
import { listLocalModels } from '$lib/server/model-catalog';

export const GET: RequestHandler = async ({ params }) => {
	const model = (await listLocalModels()).find((candidate) => candidate.id === params.modelId);
	if (model === undefined) {
		return Response.json({ detail: `Model '${params.modelId}' not found` }, { status: 404 });
	}
	return Response.json(model);
};
