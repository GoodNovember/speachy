import { Worker } from 'node:worker_threads';
import { createLogger } from '../logger.ts';

// Native inference calls block the thread they run on, and the event loop has
// no GIL to release. Every executor therefore runs inside a worker, and each
// worker handles exactly one job at a time.

const logger = createLogger('executors.worker-pool');

export type WorkerRequest =
	{ id: number; kind: 'call'; method: string; payload: unknown } | { id: number; kind: 'cancel' };

export type WorkerResponse =
	| { id: number; kind: 'ok'; value: unknown }
	| { id: number; kind: 'chunk'; value: unknown }
	| { id: number; kind: 'end' }
	| { id: number; kind: 'error'; message: string; stack?: string };

type Job = {
	id: number;
	method: string;
	payload: unknown;
	signal: AbortSignal | undefined;
	onChunk: ((value: unknown) => void) | undefined;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	abandoned: boolean;
	detachAbort: (() => void) | undefined;
};

type Slot = { worker: Worker; job: Job | undefined };

export type WorkerPoolOptions = {
	script: URL | string;
	size?: number;
	workerData?: unknown;
	name?: string;
};

export class WorkerPool {
	#script: URL | string;
	#size: number;
	#workerData: unknown;
	#name: string;

	#slots: Slot[] = [];
	#queue: Job[] = [];
	#nextId = 1;
	#closed = false;

	constructor(options: WorkerPoolOptions) {
		this.#script = options.script;
		this.#size = Math.max(1, options.size ?? 1);
		this.#workerData = options.workerData;
		this.#name = options.name ?? 'worker';
	}

	get pending(): number {
		return this.#queue.length;
	}

	get busy(): number {
		return this.#slots.filter((slot) => slot.job !== undefined).length;
	}

	call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
		return this.#submit(method, payload, signal, undefined) as Promise<T>;
	}

	stream<T>(method: string, payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
		const chunks: T[] = [];
		let finished = false;
		let failure: unknown;
		let wake: (() => void) | undefined;

		const notify = (): void => {
			wake?.();
			wake = undefined;
		};

		this.#submit(method, payload, signal, (value) => {
			chunks.push(value as T);
			notify();
		}).then(
			() => {
				finished = true;
				notify();
			},
			(error: unknown) => {
				failure = error;
				finished = true;
				notify();
			}
		);

		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<T> {
				for (;;) {
					while (chunks.length > 0) yield chunks.shift()!;
					if (finished) {
						if (failure !== undefined) throw failure;
						return;
					}
					// Safe against a race: nothing can interleave between the check
					// above and the assignment below, so no wake-up is ever missed.
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			}
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const job of this.#queue) job.reject(new Error('Worker pool closed'));
		this.#queue = [];
		await Promise.allSettled(this.#slots.map((slot) => slot.worker.terminate()));
		this.#slots = [];
	}

	#submit(
		method: string,
		payload: unknown,
		signal: AbortSignal | undefined,
		onChunk: ((value: unknown) => void) | undefined
	): Promise<unknown> {
		if (this.#closed) return Promise.reject(new Error('Worker pool closed'));
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));

		return new Promise<unknown>((resolve, reject) => {
			const job: Job = {
				id: this.#nextId++,
				method,
				payload,
				signal,
				onChunk,
				resolve,
				reject,
				abandoned: false,
				detachAbort: undefined
			};

			if (signal !== undefined) {
				const onAbort = (): void => this.#abandon(job, signal.reason ?? new Error('Aborted'));
				signal.addEventListener('abort', onAbort, { once: true });
				job.detachAbort = () => signal.removeEventListener('abort', onAbort);
			}

			this.#queue.push(job);
			this.#dispatch();
		});
	}

	// A cancelled job frees the caller immediately, but the worker may still be
	// blocked inside a native call. The slot stays busy until the worker replies
	// and that reply is discarded.
	#abandon(job: Job, reason: unknown): void {
		if (job.abandoned) return;
		job.abandoned = true;
		job.detachAbort?.();

		const queueIndex = this.#queue.indexOf(job);
		if (queueIndex !== -1) {
			this.#queue.splice(queueIndex, 1);
			job.reject(reason);
			return;
		}

		const slot = this.#slots.find((candidate) => candidate.job === job);
		slot?.worker.postMessage({ id: job.id, kind: 'cancel' } satisfies WorkerRequest);
		job.reject(reason);
	}

	#dispatch(): void {
		while (this.#queue.length > 0) {
			const slot = this.#acquireSlot();
			if (slot === undefined) return;
			const job = this.#queue.shift()!;
			slot.job = job;
			slot.worker.postMessage({
				id: job.id,
				kind: 'call',
				method: job.method,
				payload: job.payload
			} satisfies WorkerRequest);
		}
	}

	#acquireSlot(): Slot | undefined {
		const idle = this.#slots.find((slot) => slot.job === undefined);
		if (idle !== undefined) return idle;
		if (this.#slots.length >= this.#size) return undefined;
		return this.#spawn();
	}

	#spawn(): Slot {
		const worker = new Worker(this.#script, {
			workerData: this.#workerData,
			name: `${this.#name}-${this.#slots.length}`
		});
		const slot: Slot = { worker, job: undefined };

		worker.on('message', (message: WorkerResponse) => this.#onMessage(slot, message));
		worker.on('error', (error) => this.#onWorkerFailure(slot, error));
		worker.on('exit', (code) => {
			if (code === 0 || this.#closed) return;
			this.#onWorkerFailure(slot, new Error(`Worker exited with code ${code}`));
		});
		worker.unref();

		this.#slots.push(slot);
		return slot;
	}

	#onMessage(slot: Slot, message: WorkerResponse): void {
		const job = slot.job;
		if (job === undefined || job.id !== message.id) return;

		if (message.kind === 'chunk') {
			if (!job.abandoned) job.onChunk?.(message.value);
			return;
		}

		slot.job = undefined;
		job.detachAbort?.();

		if (!job.abandoned) {
			if (message.kind === 'error') {
				const error = new Error(message.message);
				if (message.stack !== undefined) error.stack = message.stack;
				job.reject(error);
			} else if (message.kind === 'ok') {
				job.resolve(message.value);
			} else {
				job.resolve(undefined);
			}
		}

		this.#dispatch();
	}

	#onWorkerFailure(slot: Slot, error: unknown): void {
		logger.exception(`Worker ${this.#name} failed`, error);
		const job = slot.job;
		slot.job = undefined;
		if (job !== undefined && !job.abandoned) {
			job.detachAbort?.();
			job.reject(error);
		}
		this.#slots = this.#slots.filter((candidate) => candidate !== slot);
		void slot.worker.terminate();
		this.#dispatch();
	}
}
