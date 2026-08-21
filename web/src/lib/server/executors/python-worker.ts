import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../logger.ts';

const logger = createLogger('executors.python-worker');

export type PythonWorkerOptions = {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	name?: string;
};

export type PythonWorkerEvent = unknown;

export type PythonWorkerRequestOptions = {
	signal?: AbortSignal;
	onEvent?: (event: PythonWorkerEvent) => void;
};

export type WorkerPing = {
	protocol_version: number;
	pid: number;
};

export type LoadedModels = {
	models: string[];
};

export type ModelLifecycleResult = {
	model_id: string;
	executor: string;
	task: string;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	onEvent: ((event: PythonWorkerEvent) => void) | undefined;
	detachAbort: (() => void) | undefined;
};

type WorkerErrorPayload = {
	code: string;
	message: string;
	data?: unknown;
};

type WorkerMessage =
	| { id: number; type: 'result'; result: unknown }
	| { id: number; type: 'event'; event: unknown }
	| { id: number | null; type: 'error'; error: WorkerErrorPayload };

export class PythonWorkerError extends Error {
	readonly code: string;
	readonly data: unknown;

	constructor(payload: WorkerErrorPayload) {
		super(payload.message);
		this.name = 'PythonWorkerError';
		this.code = payload.code;
		this.data = payload.data;
	}
}

export class PythonWorkerClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #name: string;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

	#nextId = 1;
	#stdoutBuffer = '';
	#closed = false;
	#failure: Error | undefined;
	#workerPid: number | undefined;

	constructor(options: PythonWorkerOptions = {}) {
		this.#name = options.name ?? 'python-inference';
		this.#child = spawn(
			options.command ?? process.env.SPEACHY_PYTHON ?? 'python',
			options.args ?? ['-m', 'speaches.inference_worker'],
			{
				cwd: options.cwd,
				env: options.env ?? process.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true
			}
		);

		this.#child.stdout.setEncoding('utf8');
		this.#child.stdout.on('data', (chunk: string) => this.#acceptStdout(chunk));
		this.#child.stderr.setEncoding('utf8');
		this.#child.stderr.on('data', (chunk: string) => {
			for (const line of chunk.split(/\r?\n/).filter(Boolean))
				logger.warning(`${this.#name}: ${line}`);
		});

		this.#exit = new Promise((resolve) => {
			this.#child.once('error', (error) => this.#fail(error));
			this.#child.once('close', (code, signal) => {
				if (!this.#closed) {
					this.#fail(
						new Error(
							`${this.#name} exited unexpectedly${code === null ? '' : ` with code ${code}`}${signal === null ? '' : ` on ${signal}`}`
						)
					);
				}
				resolve({ code, signal });
			});
		});
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	ping(options?: PythonWorkerRequestOptions): Promise<WorkerPing> {
		return this.request<WorkerPing>('ping', {}, options).then((result) => {
			this.#workerPid = result.pid;
			return result;
		});
	}

	listLoaded(options?: PythonWorkerRequestOptions): Promise<LoadedModels> {
		return this.request('list_loaded', {}, options);
	}

	loadModel(modelId: string, options?: PythonWorkerRequestOptions): Promise<ModelLifecycleResult> {
		return this.request('load_model', { model_id: modelId }, options);
	}

	unloadModel(
		modelId: string,
		options?: PythonWorkerRequestOptions
	): Promise<ModelLifecycleResult> {
		return this.request('unload_model', { model_id: modelId }, options);
	}

	request<T>(
		method: string,
		params: Record<string, unknown>,
		options: PythonWorkerRequestOptions = {}
	): Promise<T> {
		if (this.#failure !== undefined) return Promise.reject(this.#failure);
		if (this.#closed) return Promise.reject(new Error(`${this.#name} is closed`));
		if (options.signal?.aborted) {
			return Promise.reject(options.signal.reason ?? new Error('Request aborted'));
		}

		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingRequest = {
				resolve: (value) => resolve(value as T),
				reject,
				onEvent: options.onEvent,
				detachAbort: undefined
			};

			if (options.signal !== undefined) {
				const onAbort = (): void => {
					if (!this.#pending.delete(id)) return;
					pending.detachAbort?.();
					pending.reject(options.signal?.reason ?? new Error('Request aborted'));
					this.#write({ id, type: 'cancel' });
				};
				options.signal.addEventListener('abort', onAbort, { once: true });
				pending.detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
			}

			this.#pending.set(id, pending);
			this.#write({ id, method, params });
		});
	}

	async close(): Promise<void> {
		if (this.#closed) {
			await this.#exit;
			return;
		}
		this.#closed = true;
		this.#rejectPending(new Error(`${this.#name} closed`));
		this.#child.stdin.end();

		const forceKill = setTimeout(() => {
			// On Windows a venv's python.exe may be a launcher with a distinct
			// interpreter child. The handshake gives us that owned process's PID,
			// so a worker that cannot drain after EOF is still cleaned up.
			if (
				process.platform === 'win32' &&
				this.#workerPid !== undefined &&
				this.#workerPid !== this.#child.pid
			) {
				try {
					process.kill(this.#workerPid);
				} catch {
					// It already exited between the timer firing and the kill.
				}
			}
			this.#child.kill();
		}, 2_000);
		forceKill.unref();
		await this.#exit;
		clearTimeout(forceKill);
	}

	#write(message: Record<string, unknown>): void {
		if (this.#closed || this.#failure !== undefined || !this.#child.stdin.writable) return;
		this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
			if (error !== null && error !== undefined) this.#fail(error);
		});
	}

	#acceptStdout(chunk: string): void {
		this.#stdoutBuffer += chunk;
		for (;;) {
			const newline = this.#stdoutBuffer.indexOf('\n');
			if (newline === -1) return;
			const line = this.#stdoutBuffer.slice(0, newline).trim();
			this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
			if (line !== '') this.#acceptLine(line);
		}
	}

	#acceptLine(line: string): void {
		let message: WorkerMessage;
		try {
			message = JSON.parse(line) as WorkerMessage;
		} catch (error) {
			this.#fail(new Error(`${this.#name} emitted invalid JSON`, { cause: error }));
			return;
		}

		if (!isWorkerMessage(message)) {
			this.#fail(new Error(`${this.#name} emitted an invalid protocol message`));
			return;
		}
		if (message.id === null) {
			if (message.type !== 'error') {
				this.#fail(new Error(`${this.#name} emitted a terminal message without a request id`));
				return;
			}
			this.#fail(new PythonWorkerError(message.error));
			return;
		}

		const pending = this.#pending.get(message.id);
		if (pending === undefined) return;
		if (message.type === 'event') {
			pending.onEvent?.(message.event);
			return;
		}

		this.#pending.delete(message.id);
		pending.detachAbort?.();
		if (message.type === 'error') pending.reject(new PythonWorkerError(message.error));
		else pending.resolve(message.result);
	}

	#fail(error: unknown): void {
		if (this.#failure !== undefined) return;
		this.#failure = error instanceof Error ? error : new Error(String(error));
		this.#rejectPending(this.#failure);
		if (!this.#closed) this.#child.kill();
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			pending.detachAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
	if (typeof value !== 'object' || value === null) return false;
	const message = value as Record<string, unknown>;
	if (typeof message.id !== 'number' && message.id !== null) return false;
	if (message.type === 'result') return 'result' in message;
	if (message.type === 'event') return 'event' in message;
	if (message.type !== 'error') return false;
	if (typeof message.error !== 'object' || message.error === null) return false;
	const error = message.error as Record<string, unknown>;
	return typeof error.code === 'string' && typeof error.message === 'string';
}
