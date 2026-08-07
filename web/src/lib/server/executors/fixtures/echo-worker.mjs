import { parentPort } from 'node:worker_threads';

// Plain JavaScript so the pool tests never depend on how .ts files are loaded
// inside a worker thread. Real executor workers are built ahead of time.

const inFlight = new Map();

const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason ?? new Error('Aborted'));
			},
			{ once: true }
		);
	});

const methods = {
	echo: (payload) => payload,
	fail: () => {
		throw new Error('worker failed on purpose');
	},
	slow: async (payload, { signal }) => {
		await sleep(payload?.ms ?? 50, signal);
		return 'finished';
	},
	count: async (payload, { emit }) => {
		for (let index = 0; index < (payload?.n ?? 3); index += 1) emit(index);
		return 'done';
	},
	crash: () => {
		process.exit(7);
	}
};

parentPort.on('message', (message) => {
	if (message.kind === 'cancel') {
		inFlight.get(message.id)?.abort(new Error('Cancelled by caller'));
		return;
	}

	const method = methods[message.method];
	if (method === undefined) {
		parentPort.postMessage({
			id: message.id,
			kind: 'error',
			message: `Unknown method: ${message.method}`
		});
		return;
	}

	const controller = new AbortController();
	inFlight.set(message.id, controller);

	void (async () => {
		try {
			const value = await method(message.payload, {
				signal: controller.signal,
				emit: (chunk) => parentPort.postMessage({ id: message.id, kind: 'chunk', value: chunk })
			});
			parentPort.postMessage({ id: message.id, kind: 'ok', value });
		} catch (error) {
			parentPort.postMessage({
				id: message.id,
				kind: 'error',
				message: error instanceof Error ? error.message : String(error)
			});
		} finally {
			inFlight.delete(message.id);
		}
	})();
});
