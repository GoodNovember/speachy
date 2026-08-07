import { expect, it } from 'vitest';
import { ModelRegistry } from './model-registry.ts';

class FakeRegistry extends ModelRegistry<string, string> {
	downloaded = false;

	async *listRemoteModels(): AsyncIterable<string> {
		yield 'remote';
	}

	async *listLocalModels(): AsyncIterable<string> {
		if (this.downloaded) yield 'local';
	}

	async getModel(modelId: string): Promise<string> {
		return modelId;
	}

	async getModelFiles(): Promise<string> {
		if (!this.downloaded) throw new Error('missing');
		return 'model.bin';
	}

	async downloadModelFiles(): Promise<void> {
		this.downloaded = true;
	}
}

it('downloads missing files only once', async () => {
	const registry = new FakeRegistry();
	expect(await registry.downloadModelFilesIfNotExist('model')).toBe(true);
	expect(await registry.downloadModelFilesIfNotExist('model')).toBe(false);
});
