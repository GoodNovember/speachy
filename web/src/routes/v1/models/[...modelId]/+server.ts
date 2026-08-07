import type { RequestHandler } from './$types';
import { HubApiError } from '@huggingface/hub';
import { listLocalModels } from '$lib/server/model-catalog';
import { downloadSupportedModel, UnsupportedModelError } from '$lib/server/model-download';
import { deleteLocalModelRepo, ModelRepoNotFoundError } from '$lib/server/hf';

export const GET: RequestHandler = async ({ params }) => {
	const model = (await listLocalModels()).find((candidate) => candidate.id === params.modelId);
	if (model === undefined) {
		return Response.json({ detail: `Model '${params.modelId}' not found` }, { status: 404 });
	}
	return Response.json(model);
};

function hubStatus(error: unknown): number | undefined {
	if (error instanceof HubApiError) return error.statusCode;
	if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
	return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

export async function _modelDownloadResponse(
	modelId: string,
	download: typeof downloadSupportedModel = downloadSupportedModel
): Promise<Response> {
	try {
		const downloaded = await download(modelId);
		return new Response(
			downloaded ? `Model '${modelId}' downloaded` : `Model '${modelId}' already exists`,
			{ status: downloaded ? 200 : 201 }
		);
	} catch (error) {
		const status = hubStatus(error);
		if (
			error instanceof UnsupportedModelError ||
			(error instanceof Error && error.name === 'UnsupportedModelError') ||
			status === 404
		) {
			return Response.json({ detail: `Model '${modelId}' not found` }, { status: 404 });
		}
		if (status === 401 || status === 403) {
			return Response.json(
				{
					detail: `Model '${modelId}' is a gated repository and requires authentication. Set the HF_TOKEN environment variable to a valid Hugging Face token with access to this model.`
				},
				{ status: 401 }
			);
		}
		throw error;
	}
}

export const POST: RequestHandler = async ({ params }) => {
	return _modelDownloadResponse(params.modelId);
};

export async function _modelDeleteResponse(
	modelId: string,
	deleteModel: typeof deleteLocalModelRepo = deleteLocalModelRepo
): Promise<Response> {
	try {
		await deleteModel(modelId);
		return Response.json({ detail: `Model '${modelId}' deleted` });
	} catch (error) {
		if (
			error instanceof ModelRepoNotFoundError ||
			(typeof error === 'object' &&
				error !== null &&
				'name' in error &&
				error.name === 'ModelRepoNotFoundError')
		) {
			return Response.json({ detail: `Model repo not found: ${modelId}` }, { status: 404 });
		}
		throw error;
	}
}

export const DELETE: RequestHandler = async ({ params }) => {
	return _modelDeleteResponse(params.modelId);
};
