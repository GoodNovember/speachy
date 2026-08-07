import {
	downloadFileToCacheDir,
	getHFHubCachePath,
	getRepoFolderName,
	listFiles,
	modelInfo,
	snapshotDownload
} from '@huggingface/hub';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { listModelFiles, type ModelCardData } from './hf.ts';
import { remoteCatalogKindForMetadata, type RemoteCatalogKind } from './model-catalog.ts';

type DownloadKind = RemoteCatalogKind | 'wespeaker' | 'pyannote';

const STATIC_DOWNLOADS: Record<string, DownloadKind> = {
	'pyannote/wespeaker-voxceleb-resnet34-LM': 'wespeaker',
	'pyannote/speaker-diarization-community-1': 'pyannote'
};

const ALLOWED_FILES: Record<RemoteCatalogKind, RegExp[]> = {
	whisper: [
		/^config\.json$/,
		/^preprocessor_config\.json$/,
		/^model\.bin$/,
		/^tokenizer\.json$/,
		/^vocabulary\.[^/]+$/,
		/^README\.md$/
	],
	parakeet: [
		/^encoder-model\.onnx$/,
		/^decoder_joint-model\.onnx$/,
		/^vocab\.txt$/,
		/^config\.json$/,
		/^README\.md$/
	],
	piper: [/^model\.onnx$/, /^config\.json$/, /^README\.md$/],
	kokoro: [/^model\.onnx$/, /^voices\.bin$/, /^README\.md$/]
};

const REQUIRED_BASENAMES: Record<DownloadKind, string[]> = {
	whisper: ['config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json'],
	parakeet: ['encoder-model.onnx', 'decoder_joint-model.onnx', 'vocab.txt', 'config.json'],
	piper: ['model.onnx', 'config.json'],
	kokoro: ['model.onnx', 'voices.bin'],
	wespeaker: ['config.yaml'],
	pyannote: ['config.yaml']
};

export class UnsupportedModelError extends Error {
	constructor(readonly modelId: string) {
		super(`Model '${modelId}' not found`);
		this.name = 'UnsupportedModelError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function downloadKindForMetadata(
	modelId: string,
	card: ModelCardData
): DownloadKind | undefined {
	return STATIC_DOWNLOADS[modelId] ?? remoteCatalogKindForMetadata(modelId, card);
}

function hasRequiredFiles(kind: DownloadKind, files: string[]): boolean {
	const basenames = new Set(files.map((file) => file.replaceAll('\\', '/').split('/').at(-1)));
	return REQUIRED_BASENAMES[kind].every((name) => basenames.has(name));
}

async function filteredSnapshotDownload(
	modelId: string,
	kind: RemoteCatalogKind,
	cacheDir: string,
	accessToken?: string
): Promise<void> {
	const repo = { name: modelId, type: 'model' as const };
	const info = await modelInfo({ name: modelId, additionalFields: ['sha'], accessToken });
	const revision = info.sha;
	const storage = join(cacheDir, getRepoFolderName(repo));
	const refPath = join(storage, 'refs', 'main');
	await mkdir(dirname(refPath), { recursive: true });
	await writeFile(refPath, revision);

	for await (const entry of listFiles({ repo, recursive: true, revision, accessToken })) {
		if (entry.type !== 'file') continue;
		if (!ALLOWED_FILES[kind].some((pattern) => pattern.test(entry.path))) continue;
		await downloadFileToCacheDir({ repo, path: entry.path, revision, cacheDir, accessToken });
	}
}

export type ModelDownloadDependencies = {
	getKind(modelId: string, accessToken?: string): Promise<DownloadKind>;
	listFiles(modelId: string, cacheDir: string): Promise<string[]>;
	downloadFiltered(
		modelId: string,
		kind: RemoteCatalogKind,
		cacheDir: string,
		accessToken?: string
	): Promise<void>;
	downloadFull(modelId: string, cacheDir: string, accessToken?: string): Promise<void>;
};

const DEFAULT_DEPENDENCIES: ModelDownloadDependencies = {
	async getKind(modelId, accessToken) {
		const staticKind = STATIC_DOWNLOADS[modelId];
		if (staticKind !== undefined) return staticKind;
		const info = await modelInfo({
			name: modelId,
			additionalFields: ['cardData'],
			accessToken
		});
		if (!isRecord(info.cardData)) throw new UnsupportedModelError(modelId);
		const kind = downloadKindForMetadata(modelId, info.cardData as ModelCardData);
		if (kind === undefined) throw new UnsupportedModelError(modelId);
		return kind;
	},
	listFiles: (modelId, cacheDir) => listModelFiles(modelId, cacheDir),
	downloadFiltered: filteredSnapshotDownload,
	async downloadFull(modelId, cacheDir, accessToken) {
		await snapshotDownload({
			repo: { name: modelId, type: 'model' },
			cacheDir,
			accessToken
		});
	}
};

export async function downloadSupportedModel(
	modelId: string,
	options: {
		cacheDir?: string;
		accessToken?: string;
		dependencies?: ModelDownloadDependencies;
	} = {}
): Promise<boolean> {
	const cacheDir = options.cacheDir ?? getHFHubCachePath();
	const accessToken = options.accessToken ?? process.env.HF_TOKEN;
	const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
	const kind = await dependencies.getKind(modelId, accessToken);
	if (hasRequiredFiles(kind, await dependencies.listFiles(modelId, cacheDir))) return false;

	if (kind === 'wespeaker' || kind === 'pyannote') {
		await dependencies.downloadFull(modelId, cacheDir, accessToken);
	} else {
		await dependencies.downloadFiltered(modelId, kind, cacheDir, accessToken);
	}
	return true;
}
