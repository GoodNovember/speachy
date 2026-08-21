import { describe, expect, it, vi } from 'vitest';
import { APIProxyError } from '$lib/server/errors';
import { PythonWorkerError } from '$lib/server/executors/python-worker';
import { _loadedModelsResponse } from './+server.ts';
import { _loadModelResponse, _unloadModelResponse } from './[...modelId]/+server.ts';

function lifecycleClient(overrides: {
	loadModel?: (modelId: string) => Promise<never>;
	unloadModel?: (modelId: string) => Promise<never>;
}) {
	return {
		loadModel:
			overrides.loadModel ??
			(async (modelId: string) => ({
				model_id: modelId,
				executor: 'whisper',
				task: 'automatic-speech-recognition'
			})),
		unloadModel:
			overrides.unloadModel ??
			(async (modelId: string) => ({
				model_id: modelId,
				executor: 'whisper',
				task: 'automatic-speech-recognition'
			}))
	};
}

describe('GET /api/ps', () => {
	it('returns the worker model list', async () => {
		const listLoaded = vi.fn(async () => ({ models: ['org/model'] }));
		const response = await _loadedModelsResponse({ listLoaded });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ models: ['org/model'] });
		expect(listLoaded).toHaveBeenCalledOnce();
	});
});

describe('POST /api/ps/{model_id}', () => {
	it('returns the Python-compatible loaded response', async () => {
		const response = await _loadModelResponse('org/model', lifecycleClient({}));
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ message: "Model 'org/model' loaded." });
	});

	it('returns 409 when the model is already loaded', async () => {
		const response = await _loadModelResponse(
			'org/model',
			lifecycleClient({
				loadModel: async () => {
					throw new PythonWorkerError({
						code: 'model_already_loaded',
						message: 'already loaded'
					});
				}
			})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ message: "Model 'org/model' is already loaded." });
	});

	it('returns 404 when the worker cannot resolve a local executor', async () => {
		const response = await _loadModelResponse(
			'org/missing',
			lifecycleClient({
				loadModel: async () => {
					throw { code: 'model_not_available', message: 'not installed' };
				}
			})
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: "Model 'org/missing' not supported." });
	});
});

describe('DELETE /api/ps/{model_id}', () => {
	it('returns the Python-compatible unloaded response', async () => {
		const response = await _unloadModelResponse('org/model', lifecycleClient({}));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ message: 'Model org/model unloaded.' });
	});

	it('returns 404 when the model is not loaded', async () => {
		const response = await _unloadModelResponse(
			'org/missing',
			lifecycleClient({
				unloadModel: async () => {
					throw { code: 'model_not_loaded', message: 'missing' };
				}
			})
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ message: 'Model org/missing is not loaded.' });
	});

	it('returns 409 with the worker detail while a model is in use', async () => {
		const response = await _unloadModelResponse(
			'org/model',
			lifecycleClient({
				unloadModel: async () => {
					throw { code: 'model_in_use', message: 'Model org/model is still in use. ref_count=1' };
				}
			})
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			message: 'Model org/model is still in use. ref_count=1'
		});
	});

	it('escalates unknown worker failures through the shared API error handler', async () => {
		await expect(
			_unloadModelResponse(
				'org/model',
				lifecycleClient({
					unloadModel: async () => {
						throw new Error('process disappeared');
					}
				})
			)
		).rejects.toBeInstanceOf(APIProxyError);
	});
});
