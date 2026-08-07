import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedModel, ModelManager } from './model-manager.ts';

afterEach(() => {
	vi.useRealTimers();
});

describe('ManagedModel', () => {
	it('loads lazily and only once across concurrent acquires', async () => {
		const load = vi.fn(async () => ({ id: 'model' }));
		const managed = new ManagedModel({ modelId: 'm', ttl: -1, load });

		expect(managed.isLoaded).toBe(false);
		const [first, second] = await Promise.all([managed.acquire(), managed.acquire()]);

		expect(load).toHaveBeenCalledTimes(1);
		expect(first.model).toBe(second.model);
		expect(managed.refCount).toBe(2);
		first.release();
		second.release();
	});

	it('never unloads when ttl is -1', async () => {
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: -1, load: async () => 1, unload });

		(await managed.acquire()).release();

		expect(unload).not.toHaveBeenCalled();
		expect(managed.isLoaded).toBe(true);
	});

	it('unloads immediately when ttl is 0', async () => {
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: 0, load: async () => 1, unload });

		(await managed.acquire()).release();
		await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(1));
		expect(managed.isLoaded).toBe(false);
	});

	it('unloads after the ttl elapses when ttl is positive', async () => {
		vi.useFakeTimers();
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: 300, load: async () => 1, unload });

		(await managed.acquire()).release();
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(299_000);
		expect(unload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2_000);
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it('cancels a pending unload when the model is acquired again', async () => {
		vi.useFakeTimers();
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: 300, load: async () => 1, unload });

		(await managed.acquire()).release();
		await vi.advanceTimersByTimeAsync(100_000);

		const lease = await managed.acquire();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(unload).not.toHaveBeenCalled();

		lease.release();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it('treats a double release as a single release', async () => {
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: -1, load: async () => 1, unload });

		const first = await managed.acquire();
		const second = await managed.acquire();
		first.release();
		first.release();

		expect(managed.refCount).toBe(1);
		second.release();
		expect(managed.refCount).toBe(0);
	});

	it('refuses to unload a model that is still in use', async () => {
		const managed = new ManagedModel({ modelId: 'm', ttl: -1, load: async () => 1 });
		await managed.acquire();
		await expect(managed.unload()).rejects.toThrow(/still in use/);
	});

	it('is idempotent when unloading twice', async () => {
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: -1, load: async () => 1, unload });

		(await managed.acquire()).release();
		await managed.unload();
		await managed.unload();

		expect(unload).toHaveBeenCalledTimes(1);
	});

	it('does not leak a reference when loading fails', async () => {
		const managed = new ManagedModel({
			modelId: 'm',
			ttl: -1,
			load: async () => {
				throw new Error('no such model');
			}
		});

		await expect(managed.acquire()).rejects.toThrow('no such model');
		expect(managed.refCount).toBe(0);
	});

	it('releases the model through use() even when the callback throws', async () => {
		const unload = vi.fn();
		const managed = new ManagedModel({ modelId: 'm', ttl: 0, load: async () => 1, unload });

		await expect(
			managed.use(() => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');

		expect(managed.refCount).toBe(0);
		await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(1));
	});
});

describe('ModelManager', () => {
	it('reuses one ManagedModel per model id', () => {
		const manager = new ModelManager({ ttl: -1, load: async () => 1 });
		expect(manager.get('a')).toBe(manager.get('a'));
		expect(manager.get('a')).not.toBe(manager.get('b'));
	});

	it('reports only loaded models as loaded', async () => {
		const manager = new ModelManager({ ttl: -1, load: async () => 1 });
		manager.get('a');
		expect(manager.loadedModelIds).toEqual([]);

		(await manager.acquire('a')).release();
		expect(manager.loadedModelIds).toEqual(['a']);
	});

	it('throws when unloading a model it does not know about', async () => {
		const manager = new ModelManager({ ttl: -1, load: async () => 1 });
		await expect(manager.unload('missing')).rejects.toThrow(/not loaded/);
	});

	it('drops a model from the registry once it unloads', async () => {
		const manager = new ModelManager({ ttl: 0, load: async () => 1 });
		(await manager.acquire('a')).release();
		await vi.waitFor(() => expect(manager.loadedModelIds).toEqual([]));
	});
});
