import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	hasSherpaWhisperModel,
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_DIRECTORY_NAME
} from './native-whisper.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

describe('native Whisper model paths', () => {
	it('resolves the conventional local model directory', () => {
		const paths = resolveSherpaWhisperModelPaths({}, 'C:\\speachy\\web');
		expect(paths.directory).toBe(`C:\\speachy\\web\\models\\${SHERPA_WHISPER_DIRECTORY_NAME}`);
		expect(paths.encoder).toMatch(/tiny\.en-encoder\.int8\.onnx$/);
	});

	it('accepts an explicit model directory and requires the complete artifact set', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'speachy-sherpa-'));
		temporaryDirectories.push(directory);
		const paths = resolveSherpaWhisperModelPaths(
			{ SPEACHY_SHERPA_WHISPER_MODEL_DIR: directory },
			'C:\\ignored'
		);
		expect(hasSherpaWhisperModel(paths)).toBe(false);
		await Promise.all([
			writeFile(paths.encoder, ''),
			writeFile(paths.decoder, ''),
			writeFile(paths.tokens, '')
		]);
		expect(hasSherpaWhisperModel(paths)).toBe(true);
	});
});
