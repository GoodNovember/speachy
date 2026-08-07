import { describe, expect, it } from 'vitest';
import { ModelRepoNotFoundError } from '$lib/server/hf';
import { _modelDeleteResponse, _modelDownloadResponse } from './[...modelId]/+server.ts';

describe('POST /v1/models/{model_id}', () => {
	it('distinguishes a new download from an existing model', async () => {
		let exists = false;
		const download = async () => {
			const downloaded = !exists;
			exists = true;
			return downloaded;
		};
		const downloaded = await _modelDownloadResponse('org/model', download);
		const existing = await _modelDownloadResponse('org/model', download);
		expect(downloaded.status).toBe(200);
		expect(await downloaded.text()).toBe("Model 'org/model' downloaded");
		expect(existing.status).toBe(201);
		expect(await existing.text()).toBe("Model 'org/model' already exists");
	});

	it('returns 404 for an unsupported model', async () => {
		const error = new Error("Model 'org/missing' not found");
		error.name = 'UnsupportedModelError';
		const response = await _modelDownloadResponse('org/missing', async () => {
			throw error;
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ detail: "Model 'org/missing' not found" });
	});

	it('turns Hugging Face authorization failures into the Python-compatible response', async () => {
		const response = await _modelDownloadResponse('org/gated', async () => {
			throw { statusCode: 403 };
		});
		expect(response.status).toBe(401);
		expect(((await response.json()) as { detail: string }).detail).toContain('HF_TOKEN');
	});
});

describe('DELETE /v1/models/{model_id}', () => {
	it('returns the deleted-model detail', async () => {
		let deleted: string | undefined;
		const response = await _modelDeleteResponse('org/model', async (modelId) => {
			deleted = modelId;
		});
		expect(response.status).toBe(200);
		expect(deleted).toBe('org/model');
		expect(await response.json()).toEqual({ detail: "Model 'org/model' deleted" });
	});

	it('returns 404 when the repository is not cached', async () => {
		const response = await _modelDeleteResponse('org/missing', async () => {
			throw new ModelRepoNotFoundError('org/missing');
		});
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ detail: 'Model repo not found: org/missing' });
	});
});
