import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SHERPA_WHISPER_MODEL_ID = 'sherpa-onnx/whisper-tiny.en';
export const SHERPA_WHISPER_DIRECTORY_NAME = 'sherpa-onnx-whisper-tiny.en';

export type SherpaWhisperModelPaths = {
	directory: string;
	encoder: string;
	decoder: string;
	tokens: string;
};

export function resolveSherpaWhisperModelPaths(
	environment: NodeJS.ProcessEnv = process.env,
	workingDirectory = process.cwd()
): SherpaWhisperModelPaths {
	const directory = resolve(
		environment.SPEACHY_SHERPA_WHISPER_MODEL_DIR ??
			resolve(workingDirectory, 'models', SHERPA_WHISPER_DIRECTORY_NAME)
	);
	return {
		directory,
		encoder: resolve(directory, 'tiny.en-encoder.int8.onnx'),
		decoder: resolve(directory, 'tiny.en-decoder.int8.onnx'),
		tokens: resolve(directory, 'tiny.en-tokens.txt')
	};
}

export function hasSherpaWhisperModel(paths = resolveSherpaWhisperModelPaths()): boolean {
	return existsSync(paths.encoder) && existsSync(paths.decoder) && existsSync(paths.tokens);
}

export async function sherpaWhisperCreatedAt(
	paths = resolveSherpaWhisperModelPaths()
): Promise<number> {
	return Math.trunc((await stat(paths.encoder)).mtimeMs / 1000);
}
