import { describe, expect, it, vi } from 'vitest';
import {
	downloadKindForMetadata,
	downloadSupportedModel,
	type ModelDownloadDependencies
} from './model-download.ts';

function dependencies(files: string[] = []) {
	const value: ModelDownloadDependencies = {
		getKind: vi.fn(async (): Promise<'whisper'> => 'whisper'),
		listFiles: vi.fn(async () => files),
		downloadFiltered: vi.fn(async () => undefined),
		downloadFull: vi.fn(async () => undefined)
	};
	return value;
}

describe('model downloads', () => {
	it('classifies supported remote model metadata', () => {
		expect(
			downloadKindForMetadata('Systran/faster-whisper-small', {
				library_name: 'ctranslate2',
				pipeline_tag: 'automatic-speech-recognition'
			})
		).toBe('whisper');
		expect(downloadKindForMetadata('org/unrelated', {})).toBeUndefined();
	});

	it('does not download a complete cached model', async () => {
		const deps = dependencies([
			'/cache/config.json',
			'/cache/preprocessor_config.json',
			'/cache/model.bin',
			'/cache/tokenizer.json'
		]);
		expect(
			await downloadSupportedModel('org/model', { cacheDir: '/cache', dependencies: deps })
		).toBe(false);
		expect(deps.downloadFiltered).not.toHaveBeenCalled();
	});

	it('downloads only the selected executor snapshot for a missing model', async () => {
		const deps = dependencies();
		expect(
			await downloadSupportedModel('org/model', { cacheDir: '/cache', dependencies: deps })
		).toBe(true);
		expect(deps.downloadFiltered).toHaveBeenCalledWith('org/model', 'whisper', '/cache', undefined);
		expect(deps.downloadFull).not.toHaveBeenCalled();
	});

	it('uses a full snapshot for the static Pyannote repositories', async () => {
		const deps = dependencies();
		vi.mocked(deps.getKind).mockResolvedValue('pyannote');
		await downloadSupportedModel('pyannote/model', {
			cacheDir: '/cache',
			accessToken: 'secret',
			dependencies: deps
		});
		expect(deps.downloadFull).toHaveBeenCalledWith('pyannote/model', '/cache', 'secret');
		expect(deps.downloadFiltered).not.toHaveBeenCalled();
	});
});
