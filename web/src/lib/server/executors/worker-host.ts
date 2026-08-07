import { parentPort } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from './worker-pool.ts';

// Worker-side counterpart to WorkerPool. A method either returns a value or
// yields chunks; the pool exposes those as call() and stream() respectively.

export type MethodContext = {
	signal: AbortSignal;
	emit: (chunk: unknown) => void;
};

export type Method = (payload: unknown, context: MethodContext) => Promise<unknown> | unknown;

export function serveMethods(methods: Record<string, Method>): void {
	const port = parentPort;
	if (port === null) throw new Error('serveMethods must be called inside a worker thread');

	const inFlight = new Map<number, AbortController>();

	port.on('message', (message: WorkerRequest) => {
		if (message.kind === 'cancel') {
			inFlight.get(message.id)?.abort(new Error('Cancelled by caller'));
			return;
		}

		const method = methods[message.method];
		const send = (response: WorkerResponse): void => port.postMessage(response);

		if (method === undefined) {
			send({ id: message.id, kind: 'error', message: `Unknown method: ${message.method}` });
			return;
		}

		const controller = new AbortController();
		inFlight.set(message.id, controller);

		void (async () => {
			try {
				const value = await method(message.payload, {
					signal: controller.signal,
					emit: (chunk) => send({ id: message.id, kind: 'chunk', value: chunk })
				});
				send({ id: message.id, kind: 'ok', value });
			} catch (error) {
				send({
					id: message.id,
					kind: 'error',
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined
				});
			} finally {
				inFlight.delete(message.id);
			}
		})();
	});
}
