import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	hasSherpaDiarizationModel,
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_DIRECTORY_NAME,
	SHERPA_DIARIZATION_MODEL_ID
} from './native-diarization.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('native diarization model paths', () => {
	it('keeps the sherpa bundle distinct from the Pyannote Community-1 artifact', () => {
		const paths = resolveSherpaDiarizationModelPaths({}, 'C:\\speachy\\web');
		expect(paths.directory).toBe(`C:\\speachy\\web\\models\\${SHERPA_DIARIZATION_DIRECTORY_NAME}`);
		expect(paths.segmentation).toMatch(/segmentation\.onnx$/);
		expect(paths.embedding).toMatch(/wespeaker_en_voxceleb_resnet34_LM\.onnx$/);
		expect(SHERPA_DIARIZATION_MODEL_ID).not.toBe('pyannote/speaker-diarization-community-1');
	});

	it('requires both halves of the native bundle', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'speachy-diarization-'));
		temporaryDirectories.push(directory);
		const paths = resolveSherpaDiarizationModelPaths(
			{ SPEACHY_SHERPA_DIARIZATION_MODEL_DIR: directory },
			directory
		);
		expect(hasSherpaDiarizationModel(paths)).toBe(false);
		await writeFile(paths.segmentation, '');
		expect(hasSherpaDiarizationModel(paths)).toBe(false);
		await writeFile(paths.embedding, '');
		expect(hasSherpaDiarizationModel(paths)).toBe(true);
	});
});
