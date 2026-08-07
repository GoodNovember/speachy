import { createLogger } from '../logger.ts';

const logger = createLogger('executors.model-manager');

export type ManagedModelOptions<T> = {
	modelId: string;
	// ttl in seconds: -1 never unloads, 0 unloads on last release, > 0 unloads
	// after that many seconds idle.
	ttl: number;
	load: () => Promise<T>;
	unload?: (model: T) => Promise<void> | void;
	onUnloaded?: (modelId: string) => void;
};

export type ModelLease<T> = {
	model: T;
	release: () => void;
};

export class ManagedModel<T> {
	readonly modelId: string;

	#ttl: number;
	#loadFn: () => Promise<T>;
	#unloadFn: (model: T) => Promise<void> | void;
	#onUnloaded: ((modelId: string) => void) | undefined;

	#model: T | undefined;
	#loading: Promise<T> | undefined;
	#refCount = 0;
	#expireTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: ManagedModelOptions<T>) {
		this.modelId = options.modelId;
		this.#ttl = options.ttl;
		this.#loadFn = options.load;
		this.#unloadFn = options.unload ?? (() => {});
		this.#onUnloaded = options.onUnloaded;
	}

	get isLoaded(): boolean {
		return this.#model !== undefined;
	}

	get refCount(): number {
		return this.#refCount;
	}

	async acquire(): Promise<ModelLease<T>> {
		// Increment before awaiting the load so a pending expiry cannot unload
		// the model out from under a caller that is still waiting for it.
		this.#cancelExpiry();
		this.#refCount += 1;
		try {
			const model = await this.#ensureLoaded();
			let released = false;
			return {
				model,
				release: () => {
					if (released) return;
					released = true;
					this.#release();
				}
			};
		} catch (error) {
			this.#refCount -= 1;
			throw error;
		}
	}

	async use<R>(fn: (model: T) => Promise<R> | R): Promise<R> {
		const lease = await this.acquire();
		try {
			return await fn(lease.model);
		} finally {
			lease.release();
		}
	}

	async unload(): Promise<void> {
		this.#cancelExpiry();
		if (this.#refCount > 0) {
			throw new Error(`Model ${this.modelId} is still in use (refCount=${this.#refCount})`);
		}
		const model = this.#model;
		// Idempotent, unlike the Python original which raises. A TTL timer and an
		// explicit unload can race, and losing that race is not an error.
		if (model === undefined) return;
		this.#model = undefined;
		await this.#unloadFn(model);
		logger.info(`Model ${this.modelId} unloaded`);
		this.#onUnloaded?.(this.modelId);
	}

	#ensureLoaded(): Promise<T> {
		if (this.#model !== undefined) return Promise.resolve(this.#model);
		this.#loading ??= (async () => {
			const start = performance.now();
			logger.debug(`Loading model ${this.modelId}`);
			try {
				const model = await this.#loadFn();
				this.#model = model;
				logger.info(`Model ${this.modelId} loaded in ${(performance.now() - start).toFixed(0)}ms`);
				return model;
			} finally {
				this.#loading = undefined;
			}
		})();
		return this.#loading;
	}

	#release(): void {
		this.#refCount -= 1;
		if (this.#refCount > 0) return;
		if (this.#ttl < 0) {
			logger.debug(`Model ${this.modelId} is idle, not unloading`);
			return;
		}
		if (this.#ttl === 0) {
			void this.unload().catch((error) => logger.exception('Immediate unload failed', error));
			return;
		}
		logger.debug(`Model ${this.modelId} is idle, scheduling unload in ${this.#ttl}s`);
		this.#expireTimer = setTimeout(() => {
			this.#expireTimer = undefined;
			void this.unload().catch((error) => logger.exception('Scheduled unload failed', error));
		}, this.#ttl * 1000);
		// A pending unload must not keep the process alive on shutdown.
		this.#expireTimer.unref?.();
	}

	#cancelExpiry(): void {
		if (this.#expireTimer === undefined) return;
		clearTimeout(this.#expireTimer);
		this.#expireTimer = undefined;
	}
}

export class ModelManager<T> {
	#ttl: number;
	#loadFn: (modelId: string) => Promise<T>;
	#unloadFn: ((model: T) => Promise<void> | void) | undefined;
	#models = new Map<string, ManagedModel<T>>();

	constructor(options: {
		ttl: number;
		load: (modelId: string) => Promise<T>;
		unload?: (model: T) => Promise<void> | void;
	}) {
		this.#ttl = options.ttl;
		this.#loadFn = options.load;
		this.#unloadFn = options.unload;
	}

	get loadedModelIds(): string[] {
		return [...this.#models.values()]
			.filter((model) => model.isLoaded)
			.map((model) => model.modelId);
	}

	get(modelId: string): ManagedModel<T> {
		let managed = this.#models.get(modelId);
		if (managed === undefined) {
			managed = new ManagedModel<T>({
				modelId,
				ttl: this.#ttl,
				load: () => this.#loadFn(modelId),
				unload: this.#unloadFn,
				onUnloaded: (id) => this.#models.delete(id)
			});
			this.#models.set(modelId, managed);
		}
		return managed;
	}

	acquire(modelId: string): Promise<ModelLease<T>> {
		return this.get(modelId).acquire();
	}

	use<R>(modelId: string, fn: (model: T) => Promise<R> | R): Promise<R> {
		return this.get(modelId).use(fn);
	}

	async unload(modelId: string): Promise<void> {
		const managed = this.#models.get(modelId);
		if (managed === undefined) throw new Error(`Model ${modelId} is not loaded`);
		await managed.unload();
		this.#models.delete(modelId);
	}

	async unloadAll(): Promise<void> {
		await Promise.allSettled([...this.#models.values()].map((model) => model.unload()));
		this.#models.clear();
	}
}
