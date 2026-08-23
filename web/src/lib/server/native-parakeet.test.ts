import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	hasSherpaParakeetModel,
	resolveSherpaParakeetModelPaths,
	SHERPA_PARAKEET_DIRECTORY_NAME
} from './native-parakeet.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('native Parakeet model paths', () => {
	it('uses a model identity distinct from the Hugging Face Parakeet artifact', () => {
		const paths = resolveSherpaParakeetModelPaths({}, 'C:\\speachy\\web');
		expect(paths.directory).toBe(`C:\\speachy\\web\\models\\${SHERPA_PARAKEET_DIRECTORY_NAME}`);
		expect(paths.joiner).toMatch(/joiner\.int8\.onnx$/);
	});

	it('requires the complete transducer artifact', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'speachy-parakeet-'));
		temporaryDirectories.push(directory);
		const paths = resolveSherpaParakeetModelPaths(
			{ SPEACHY_SHERPA_PARAKEET_MODEL_DIR: directory },
			directory
		);
		expect(hasSherpaParakeetModel(paths)).toBe(false);
		await Promise.all([
			writeFile(paths.encoder, ''),
			writeFile(paths.decoder, ''),
			writeFile(paths.joiner, ''),
			writeFile(paths.tokens, '')
		]);
		expect(hasSherpaParakeetModel(paths)).toBe(true);
	});
});
