import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PythonWorkerClient, PythonWorkerError } from './python-worker.ts';

const FIXTURE = new URL('./fixtures/python-worker.mjs', import.meta.url);
let worker: PythonWorkerClient | undefined;

function createWorker(): PythonWorkerClient {
	worker = new PythonWorkerClient({
		command: process.execPath,
		args: [fileURLToPath(FIXTURE)],
		name: 'python-worker-fixture'
	});
	return worker;
}

afterEach(async () => {
	await worker?.close();
	worker = undefined;
});

describe('PythonWorkerClient', () => {
	it('round-trips lifecycle requests over buffered NDJSON', async () => {
		const created = createWorker();
		await expect(created.ping()).resolves.toMatchObject({ protocol_version: 1 });
		await expect(created.listLoaded()).resolves.toEqual({ models: [] });
	});

	it('delivers streaming events before the terminal result', async () => {
		const events: unknown[] = [];
		const result = await createWorker().request(
			'events',
			{},
			{ onEvent: (event) => events.push(event) }
		);
		expect(events).toEqual([{ index: 0 }, { index: 1 }]);
		expect(result).toBe('done');
	});

	it('preserves structured worker errors', async () => {
		const error = await createWorker()
			.request('fail', {})
			.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(PythonWorkerError);
		expect(error).toMatchObject({
			code: 'fixture_failure',
			message: 'failed on purpose',
			data: { retryable: false }
		});
	});

	it('rejects immediately and notifies the worker when the caller aborts', async () => {
		const controller = new AbortController();
		const pending = createWorker().request('wait', { ms: 5_000 }, { signal: controller.signal });
		controller.abort(new Error('caller disconnected'));
		await expect(pending).rejects.toThrow('caller disconnected');
	});

	it('rejects unknown methods without losing the process', async () => {
		const created = createWorker();
		await expect(created.request('missing', {})).rejects.toMatchObject({
			code: 'method_not_found'
		});
		await expect(created.ping()).resolves.toMatchObject({ protocol_version: 1 });
	});

	it('rejects requests after close', async () => {
		const created = createWorker();
		await created.close();
		await expect(created.ping()).rejects.toThrow(/closed/);
	});
});
