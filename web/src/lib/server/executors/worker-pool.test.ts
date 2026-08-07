import { afterEach, describe, expect, it } from 'vitest';
import { WorkerPool } from './worker-pool.ts';

const SCRIPT = new URL('./fixtures/echo-worker.mjs', import.meta.url);

let pool: WorkerPool | undefined;

function createPool(size = 1): WorkerPool {
	pool = new WorkerPool({ script: SCRIPT, size, name: 'test' });
	return pool;
}

afterEach(async () => {
	await pool?.close();
	pool = undefined;
});

describe('WorkerPool', () => {
	it('round-trips a call', async () => {
		await expect(createPool().call('echo', { hello: 'world' })).resolves.toEqual({
			hello: 'world'
		});
	});

	it('propagates an error thrown inside the worker', async () => {
		await expect(createPool().call('fail', undefined)).rejects.toThrow('worker failed on purpose');
	});

	it('rejects an unknown method', async () => {
		await expect(createPool().call('nope', undefined)).rejects.toThrow(/Unknown method/);
	});

	it('yields streamed chunks in order and then completes', async () => {
		const received: number[] = [];
		for await (const chunk of createPool().stream<number>('count', { n: 4 })) {
			received.push(chunk);
		}
		expect(received).toEqual([0, 1, 2, 3]);
	});

	it('surfaces a stream failure to the consumer', async () => {
		const iterate = async (): Promise<void> => {
			for await (const _chunk of createPool().stream('fail', undefined)) {
				// no chunks are expected
			}
		};
		await expect(iterate()).rejects.toThrow('worker failed on purpose');
	});

	it('rejects immediately when the signal is already aborted', async () => {
		await expect(
			createPool().call('echo', 1, AbortSignal.abort(new Error('too late')))
		).rejects.toThrow('too late');
	});

	it('frees the caller as soon as an in-flight job is aborted', async () => {
		const controller = new AbortController();
		const inFlight = createPool().call('slow', { ms: 5_000 }, controller.signal);
		controller.abort(new Error('caller hung up'));
		await expect(inFlight).rejects.toThrow('caller hung up');
	});

	it('removes an aborted job from the queue without running it', async () => {
		const created = createPool(1);
		const blocker = created.call('slow', { ms: 200 });

		const controller = new AbortController();
		const queued = created.call('echo', 'queued', controller.signal);
		expect(created.pending).toBe(1);

		controller.abort(new Error('gave up waiting'));
		await expect(queued).rejects.toThrow('gave up waiting');
		expect(created.pending).toBe(0);
		await expect(blocker).resolves.toBe('finished');
	});

	it('queues work beyond the pool size and drains it', async () => {
		const created = createPool(2);
		const results = await Promise.all(
			Array.from({ length: 6 }, (_unused, index) => created.call<number>('echo', index))
		);
		expect(results).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('runs concurrently up to the pool size', async () => {
		const created = createPool(3);
		const started = performance.now();
		await Promise.all(Array.from({ length: 3 }, () => created.call('slow', { ms: 150 })));
		// Serial execution would take at least 450ms.
		expect(performance.now() - started).toBeLessThan(400);
	});

	it('rejects the in-flight job when a worker dies', async () => {
		await expect(createPool().call('crash', undefined)).rejects.toThrow(/exited with code 7/);
	});

	it('recovers and serves later calls after a worker dies', async () => {
		const created = createPool();
		await expect(created.call('crash', undefined)).rejects.toThrow();
		await expect(created.call('echo', 'still here')).resolves.toBe('still here');
	});

	it('rejects new work once closed', async () => {
		const created = createPool();
		await created.close();
		await expect(created.call('echo', 1)).rejects.toThrow(/closed/);
	});
});
