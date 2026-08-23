import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const SHERPA_DIARIZATION_MODEL_ID =
	'sherpa-onnx/pyannote-segmentation-3.0+wespeaker-voxceleb-resnet34-LM';
export const SHERPA_DIARIZATION_DIRECTORY_NAME =
	'sherpa-onnx-pyannote-segmentation-3-0-wespeaker-en-voxceleb-resnet34-LM';

export type SherpaDiarizationModelPaths = {
	directory: string;
	segmentation: string;
	embedding: string;
};

export function resolveSherpaDiarizationModelPaths(
	environment: NodeJS.ProcessEnv = process.env,
	workingDirectory = process.cwd()
): SherpaDiarizationModelPaths {
	const directory = resolve(
		environment.SPEACHY_SHERPA_DIARIZATION_MODEL_DIR ??
			resolve(workingDirectory, 'models', SHERPA_DIARIZATION_DIRECTORY_NAME)
	);
	return {
		directory,
		segmentation: resolve(directory, 'segmentation.onnx'),
		embedding: resolve(directory, 'wespeaker_en_voxceleb_resnet34_LM.onnx')
	};
}

export function hasSherpaDiarizationModel(paths = resolveSherpaDiarizationModelPaths()): boolean {
	return existsSync(paths.segmentation) && existsSync(paths.embedding);
}

export async function sherpaDiarizationCreatedAt(
	paths = resolveSherpaDiarizationModelPaths()
): Promise<number> {
	const timestamps = await Promise.all([
		stat(paths.segmentation).then((info) => info.mtimeMs),
		stat(paths.embedding).then((info) => info.mtimeMs)
	]);
	return Math.trunc(Math.max(...timestamps) / 1000);
}
