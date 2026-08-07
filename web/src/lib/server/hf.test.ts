import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	deleteLocalModelRepo,
	doesLocalModelExist,
	extractLanguageList,
	getCachedModelReposInfo,
	getModelCardDataFromCachedRepoInfo,
	getModelRepoPath,
	HfModelFilter,
	HuggingFaceCacheNotFoundError,
	listLocalModelIds,
	listModelFiles,
	loadRepoModelCardData,
	modelIdFromPath,
	ModelRepoNotFoundError
} from './hf.ts';

const temporaryDirectories: string[] = [];

async function temporaryCache(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'speachy-hf-test-'));
	temporaryDirectories.push(path);
	return path;
}

async function addRepo(
	cache: string,
	modelId: string,
	metadata: string,
	revision = 'abc123'
): Promise<string> {
	const repo = join(cache, `models--${modelId.replaceAll('/', '--')}`);
	const snapshot = join(repo, 'snapshots', revision);
	await mkdir(snapshot, { recursive: true });
	await mkdir(join(repo, 'refs'), { recursive: true });
	await writeFile(join(repo, 'refs', 'main'), revision);
	await writeFile(join(snapshot, 'README.md'), `---\n${metadata}\n---\n# Model\n`);
	return repo;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
	);
});

describe('HfModelFilter', () => {
	const filter = new HfModelFilter({
		modelName: 'whisper',
		libraryName: 'ctranslate2',
		task: 'automatic-speech-recognition',
		tags: ['speaches']
	});

	it('matches model name and model-card metadata', () => {
		expect(
			filter.passesFilter('Org/Whisper-Tiny', {
				library_name: 'ctranslate2',
				pipeline_tag: 'automatic-speech-recognition',
				tags: ['speaches']
			})
		).toBe(true);
	});

	it('accepts legacy library and tag-based task metadata', () => {
		expect(
			filter.passesFilter('org/whisper-tiny', {
				library: 'ctranslate2',
				tags: ['automatic-speech-recognition', 'speaches']
			})
		).toBe(true);
	});

	it('rejects a missing required tag', () => {
		expect(
			filter.passesFilter('org/whisper-tiny', {
				library_name: 'ctranslate2',
				pipeline_tag: 'automatic-speech-recognition',
				tags: []
			})
		).toBe(false);
	});

	it('translates to Hugging Face search parameters', () => {
		expect(filter.toHubSearch()).toEqual({
			query: 'whisper',
			task: 'automatic-speech-recognition',
			tags: ['ctranslate2', 'speaches']
		});
	});
});

describe('model-card metadata', () => {
	it('parses YAML frontmatter and filters malformed language entries', async () => {
		const cache = await temporaryCache();
		const repo = await addRepo(
			cache,
			'org/model',
			'language: [en, false, fr]\nlibrary_name: ctranslate2\npipeline_tag: automatic-speech-recognition'
		);
		const card = await loadRepoModelCardData(join(repo, 'snapshots', 'abc123', 'README.md'));
		expect(extractLanguageList(card)).toEqual(['en', 'fr']);
	});

	it('selects the revision referenced by main', async () => {
		const cache = await temporaryCache();
		const repo = await addRepo(cache, 'org/model', 'language: en', 'old');
		await mkdir(join(repo, 'snapshots', 'current'), { recursive: true });
		await writeFile(join(repo, 'snapshots', 'current', 'README.md'), '---\nlanguage: fr\n---\n');
		await writeFile(join(repo, 'refs', 'main'), 'current');
		const [info] = await getCachedModelReposInfo(cache);
		expect(extractLanguageList((await getModelCardDataFromCachedRepoInfo(info!))!)).toEqual(['fr']);
	});
});

describe('local cache operations', () => {
	it('lists only model repositories and maps cache names to ids', async () => {
		const cache = await temporaryCache();
		await addRepo(cache, 'Systran/faster-whisper-tiny', 'language: en');
		await mkdir(join(cache, 'datasets--org--data'));
		await writeFile(join(cache, 'unrelated'), 'x');
		expect(await listLocalModelIds(cache)).toEqual(['Systran/faster-whisper-tiny']);
		expect(modelIdFromPath('models--google--fleurs')).toBe('google/fleurs');
		expect(await doesLocalModelExist('Systran/faster-whisper-tiny', cache)).toBe(true);
	});

	it('finds a repository and recursively lists snapshot files', async () => {
		const cache = await temporaryCache();
		const repo = await addRepo(cache, 'org/model', 'language: en');
		await mkdir(join(repo, 'snapshots', 'abc123', 'nested'));
		await writeFile(join(repo, 'snapshots', 'abc123', 'nested', 'config.json'), '{}');
		expect(await getModelRepoPath('org/model', cache)).toBe(repo);
		expect(
			(await listModelFiles('org/model', cache)).map((path) => path.slice(repo.length + 1)).sort()
		).toEqual(
			[
				join('snapshots', 'abc123', 'README.md'),
				join('snapshots', 'abc123', 'nested', 'config.json')
			].sort()
		);
	});

	it('reports a missing cache distinctly', async () => {
		const cache = await temporaryCache();
		await rm(cache, { recursive: true });
		expect(await listLocalModelIds(cache)).toEqual([]);
		await expect(getModelRepoPath('org/model', cache)).rejects.toBeInstanceOf(
			HuggingFaceCacheNotFoundError
		);
	});

	it('deletes exactly one resolved model repository', async () => {
		const cache = await temporaryCache();
		await addRepo(cache, 'org/delete-me', 'language: en');
		await addRepo(cache, 'org/keep-me', 'language: en');
		await deleteLocalModelRepo('org/delete-me', cache);
		expect(await listLocalModelIds(cache)).toEqual(['org/keep-me']);
	});

	it('reports a missing repository without changing the cache', async () => {
		const cache = await temporaryCache();
		await addRepo(cache, 'org/keep-me', 'language: en');
		await expect(deleteLocalModelRepo('org/missing', cache)).rejects.toBeInstanceOf(
			ModelRepoNotFoundError
		);
		expect(await listLocalModelIds(cache)).toEqual(['org/keep-me']);
	});
});
