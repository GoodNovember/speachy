import {
	getHFHubCachePath,
	listModels,
	scanCacheDir,
	type CachedRepoInfo,
	type ModelEntry
} from '@huggingface/hub';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

export const MODEL_CARD_DOESNT_EXIST_ERROR_MESSAGE =
	'The model repository does not contain a valid model card. This is likely due to the breaking change introduce v0.8.0 release. You should try to delete the model and re-download it using `DELETE /v1/models/{model_id}` and then `POST /v1/models`. Or if the issue persists, you can try to delete the entire HuggingFace cache directory (delete the whole volume if you are using Docker). Apologies for the inconvenience.';

export type ModelCardData = {
	language?: string | unknown[] | null;
	library_name?: string | null;
	library?: string | null;
	pipeline_tag?: string | null;
	tags?: string[] | null;
	[key: string]: unknown;
};

export type HfModelFilterOptions = {
	modelName?: string;
	libraryName?: string;
	task?: string;
	tags?: Iterable<string>;
};

export class HfModelFilter {
	readonly modelName: string | undefined;
	readonly libraryName: string | undefined;
	readonly task: string | undefined;
	readonly tags: ReadonlySet<string> | undefined;

	constructor(options: HfModelFilterOptions = {}) {
		this.modelName = options.modelName;
		this.libraryName = options.libraryName;
		this.task = options.task;
		this.tags = options.tags === undefined ? undefined : new Set(options.tags);
	}

	passesFilter(modelId: string, card: ModelCardData): boolean {
		if (
			this.modelName !== undefined &&
			!modelId.toLowerCase().includes(this.modelName.toLowerCase())
		) {
			return false;
		}

		const cardTags = new Set(card.tags ?? []);
		const library = card.library_name ?? card.library;
		if (
			this.libraryName !== undefined &&
			library !== this.libraryName &&
			!cardTags.has(this.libraryName)
		) {
			return false;
		}
		if (this.task !== undefined && card.pipeline_tag !== this.task && !cardTags.has(this.task)) {
			return false;
		}
		if (this.tags !== undefined && [...this.tags].some((tag) => !cardTags.has(tag))) return false;
		return true;
	}

	toHubSearch(): { query?: string; task?: string; tags?: string[] } {
		const tags = [
			...(this.libraryName === undefined ? [] : [this.libraryName]),
			...(this.tags ?? [])
		];
		return {
			...(this.modelName === undefined ? {} : { query: this.modelName }),
			...(this.task === undefined ? {} : { task: this.task }),
			...(tags.length === 0 ? {} : { tags })
		};
	}
}

export type RemoteModelInfo = {
	id: string;
	createdAt: Date;
	cardData: ModelCardData;
};

type HubModelWithCard = ModelEntry & {
	createdAt?: Date | string;
	cardData?: unknown;
};

export async function* listRemoteModels(
	filter: HfModelFilter,
	options: { accessToken?: string; limit?: number } = {}
): AsyncGenerator<RemoteModelInfo> {
	const search = filter.toHubSearch();
	const models = listModels({
		search: search as Parameters<typeof listModels>[0] extends { search?: infer Search }
			? Search
			: never,
		additionalFields: ['cardData', 'createdAt'],
		...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
		...(options.limit === undefined ? {} : { limit: options.limit })
	});

	for await (const model of models as AsyncIterable<HubModelWithCard>) {
		if (model.createdAt === undefined || !isRecord(model.cardData)) continue;
		const cardData = model.cardData as ModelCardData;
		const createdAt = model.createdAt instanceof Date ? model.createdAt : new Date(model.createdAt);
		if (Number.isNaN(createdAt.getTime())) continue;
		if (filter.passesFilter(model.name, cardData)) {
			yield { id: model.name, createdAt, cardData };
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function getCachedModelReposInfo(
	cacheDir = getHFHubCachePath()
): Promise<CachedRepoInfo[]> {
	const cache = await scanCacheDir(cacheDir);
	return cache.repos.filter((repo) => repo.id.type === 'model');
}

function chooseRevision(repo: CachedRepoInfo): CachedRepoInfo['revisions'][number] | undefined {
	if (repo.revisions.length <= 1) return repo.revisions[0];
	const main = repo.revisions.find((revision) => revision.refs.includes('main'));
	if (main === undefined)
		throw new Error(`Model repo '${repo.id.name}' has several revisions but no main ref`);
	return main;
}

export async function getModelCardDataFromCachedRepoInfo(
	repo: CachedRepoInfo
): Promise<ModelCardData | undefined> {
	const revision = chooseRevision(repo);
	if (revision === undefined) return undefined;
	const readme = revision.files
		.filter((file) => basename(file.path) === 'README.md')
		.sort((left, right) => {
			const leftDepth = relative(revision.path, left.path).split(sep).length;
			const rightDepth = relative(revision.path, right.path).split(sep).length;
			return leftDepth - rightDepth;
		})[0];
	return readme === undefined ? undefined : loadRepoModelCardData(readme.path);
}

export async function loadRepoModelCardData(readmePath: string): Promise<ModelCardData> {
	const content = await readFile(readmePath, 'utf8');
	const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
	if (frontmatter === undefined) return {};
	const parsed = parse(frontmatter) as unknown;
	if (!isRecord(parsed)) throw new Error(`Invalid model-card metadata in ${readmePath}`);
	return parsed as ModelCardData;
}

export function extractLanguageList(card: ModelCardData): string[] {
	if (typeof card.language === 'string') return [card.language];
	if (!Array.isArray(card.language)) return [];
	return card.language.filter((language): language is string => typeof language === 'string');
}

export function modelIdFromPath(repoPath: string): string {
	const name = basename(repoPath);
	if (!name.startsWith('models--')) throw new Error(`Not a Hugging Face model cache path: ${name}`);
	return name.slice('models--'.length).replaceAll('--', '/');
}

export async function listLocalModelIds(cacheDir = getHFHubCachePath()): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(resolve(cacheDir), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith('models--'))
		.map((entry) => modelIdFromPath(entry.name));
}

export async function doesLocalModelExist(
	modelId: string,
	cacheDir = getHFHubCachePath()
): Promise<boolean> {
	return (await listLocalModelIds(cacheDir)).includes(modelId);
}

export class HuggingFaceCacheNotFoundError extends Error {
	constructor(readonly cacheDir: string) {
		super(`Cache directory not found: ${cacheDir}. Set HF_HUB_CACHE or pass cacheDir.`);
		this.name = 'HuggingFaceCacheNotFoundError';
	}
}

export async function getModelRepoPath(
	modelId: string,
	cacheDir = getHFHubCachePath()
): Promise<string | undefined> {
	const resolvedCache = resolve(cacheDir);
	let cacheStats;
	try {
		cacheStats = await stat(resolvedCache);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new HuggingFaceCacheNotFoundError(resolvedCache);
		}
		throw error;
	}
	if (!cacheStats.isDirectory())
		throw new Error(`Scan cache expects a directory: ${resolvedCache}`);

	for (const entry of await readdir(resolvedCache, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith('models--')) continue;
		if (modelIdFromPath(entry.name) === modelId) return resolve(resolvedCache, entry.name);
	}
	return undefined;
}

async function* walkFiles(directory: string): AsyncGenerator<string> {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) yield* walkFiles(path);
		else if (entry.isFile() || entry.isSymbolicLink()) yield path;
	}
}

export async function listModelFiles(
	modelId: string,
	cacheDir = getHFHubCachePath()
): Promise<string[]> {
	const repoPath = await getModelRepoPath(modelId, cacheDir);
	if (repoPath === undefined) return [];
	const snapshots = resolve(repoPath, 'snapshots');
	try {
		if (!(await stat(snapshots)).isDirectory()) return [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const files: string[] = [];
	for await (const file of walkFiles(snapshots)) files.push(file);
	return files;
}

export async function deleteLocalModelRepo(
	modelId: string,
	cacheDir = getHFHubCachePath()
): Promise<void> {
	const repoPath = await getModelRepoPath(modelId, cacheDir);
	if (repoPath === undefined) throw new Error(`Model repo not found: ${modelId}`);
	if (dirname(repoPath) !== resolve(cacheDir) || modelIdFromPath(repoPath) !== modelId) {
		throw new Error(`Refusing to delete an invalid model cache path: ${repoPath}`);
	}
	await rm(repoPath, { recursive: true, force: false });
}
