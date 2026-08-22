import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';
import type { Runtime } from '../runtime.ts';
import { PythonWorkerClient } from './python-worker.ts';
import {
	closeInferenceWorker,
	resolvePythonWorkerLaunch,
	startInferenceWorker
} from './python-runtime.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/python-worker.mjs', import.meta.url));

function runtime(): Runtime {
	return { config: loadConfig({}), startedAt: 0 };
}

function fixtureWorker(protocolVersion = 1): PythonWorkerClient {
	return new PythonWorkerClient({
		command: process.execPath,
		args: [FIXTURE],
		env: {
			...process.env,
			SPEACHY_FIXTURE_PROTOCOL_VERSION: String(protocolVersion)
		},
		name: 'python-runtime-fixture'
	});
}

describe('Python inference runtime', () => {
	it('resolves the repository venv and project root when the server starts from web', () => {
		const web = resolve('C:\\fixture', 'speachy', 'web');
		const root = resolve(web, '..');
		const python = resolve(root, '.venv', 'Scripts/python.exe');
		const existing = new Set([resolve(root, 'pyproject.toml'), python]);

		expect(
			resolvePythonWorkerLaunch(
				{},
				{ cwd: web, platform: 'win32', pathExists: (path) => existing.has(path) }
			)
		).toEqual({ command: python, cwd: root });
	});

	it('keeps an explicit Python override while still using the project root', () => {
		const web = resolve('C:\\fixture', 'speachy', 'web');
		const root = resolve(web, '..');
		expect(
			resolvePythonWorkerLaunch(
				{ SPEACHY_PYTHON: 'custom-python' },
				{
					cwd: web,
					platform: 'win32',
					pathExists: (path) => path === resolve(root, 'pyproject.toml')
				}
			)
		).toEqual({ command: 'custom-python', cwd: root });
	});

	it('shares one concurrently-started worker and closes it once', async () => {
		const state = runtime();
		let starts = 0;
		const factory = () => {
			starts += 1;
			return fixtureWorker();
		};

		const [first, second] = await Promise.all([
			startInferenceWorker(state, factory),
			startInferenceWorker(state, factory)
		]);
		expect(first).toBe(second);
		expect(starts).toBe(1);
		expect(state.inferenceWorker).toBe(first);
		expect(state.inferenceWorkerStart).toBeUndefined();

		await closeInferenceWorker(state);
		expect(state.inferenceWorker).toBeUndefined();
		await expect(first.ping()).rejects.toThrow(/closed/);
	});

	it('rejects a mismatched protocol, closes the child, and permits a retry', async () => {
		const state = runtime();
		await expect(startInferenceWorker(state, () => fixtureWorker(99))).rejects.toThrow(
			/Unsupported Python worker protocol 99/
		);
		expect(state.inferenceWorker).toBeUndefined();
		expect(state.inferenceWorkerStart).toBeUndefined();

		const retried = await startInferenceWorker(state, () => fixtureWorker());
		await expect(retried.listLoaded()).resolves.toEqual({ models: [] });
		await closeInferenceWorker(state);
	});
});
