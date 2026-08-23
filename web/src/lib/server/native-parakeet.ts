import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SHERPA_PARAKEET_MODEL_ID = 'sherpa-onnx/parakeet-tdt-0.6b-v2-int8';
export const SHERPA_PARAKEET_DIRECTORY_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';

export type SherpaParakeetModelPaths = {
	directory: string;
	encoder: string;
	decoder: string;
	joiner: string;
	tokens: string;
};

export function resolveSherpaParakeetModelPaths(
	environment: NodeJS.ProcessEnv = process.env,
	workingDirectory = process.cwd()
): SherpaParakeetModelPaths {
	const directory = resolve(
		environment.SPEACHY_SHERPA_PARAKEET_MODEL_DIR ??
			resolve(workingDirectory, 'models', SHERPA_PARAKEET_DIRECTORY_NAME)
	);
	return {
		directory,
		encoder: resolve(directory, 'encoder.int8.onnx'),
		decoder: resolve(directory, 'decoder.int8.onnx'),
		joiner: resolve(directory, 'joiner.int8.onnx'),
		tokens: resolve(directory, 'tokens.txt')
	};
}

export function hasSherpaParakeetModel(paths = resolveSherpaParakeetModelPaths()): boolean {
	return (
		existsSync(paths.encoder) &&
		existsSync(paths.decoder) &&
		existsSync(paths.joiner) &&
		existsSync(paths.tokens)
	);
}

export async function sherpaParakeetCreatedAt(
	paths = resolveSherpaParakeetModelPaths()
): Promise<number> {
	return Math.trunc((await stat(paths.encoder)).mtimeMs / 1000);
}
