import type { CachedRepoInfo } from '@huggingface/hub';
import type { Model, ModelTask, Voice } from '$lib/types/api';
import {
	extractLanguageList,
	getCachedModelReposInfo,
	getModelCardDataFromCachedRepoInfo,
	HfModelFilter,
	type ModelCardData
} from './hf.ts';

export type CatalogVoice = Voice & { id: string; name: string };
export type CatalogModel = Model & {
	object: 'model';
	task: ModelTask;
	sample_rate?: number;
	voices?: CatalogVoice[];
};

function namedVoices(
	names: string[],
	language: string,
	gender?: 'female' | 'male'
): CatalogVoice[] {
	return names.map((name) => ({
		id: name,
		name,
		language,
		...(gender === undefined ? {} : { gender })
	}));
}

export const KOKORO_VOICES: CatalogVoice[] = [
	...namedVoices(
		[
			'af_heart',
			'af_alloy',
			'af_aoede',
			'af_bella',
			'af_jessica',
			'af_kore',
			'af_nicole',
			'af_nova',
			'af_river',
			'af_sarah',
			'af_sky'
		],
		'en-us',
		'female'
	),
	...namedVoices(
		[
			'am_adam',
			'am_echo',
			'am_eric',
			'am_fenrir',
			'am_liam',
			'am_michael',
			'am_onyx',
			'am_puck',
			'am_santa'
		],
		'en-us',
		'male'
	),
	...namedVoices(['bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily'], 'en-gb', 'female'),
	...namedVoices(['bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'], 'en-gb', 'male'),
	...namedVoices(['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro'], 'ja', 'female'),
	...namedVoices(['jm_kumo'], 'ja', 'male'),
	...namedVoices(['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi'], 'zh', 'female'),
	...namedVoices(['zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang'], 'zh', 'male'),
	...namedVoices(['ef_dora'], 'es', 'female'),
	...namedVoices(['em_alex', 'em_santa'], 'es', 'male'),
	...namedVoices(['ff_siwis'], 'fr-fr', 'female'),
	...namedVoices(['hf_alpha', 'hf_beta'], 'hi', 'female'),
	...namedVoices(['hm_omega', 'hm_psi'], 'hi', 'male'),
	...namedVoices(['if_sara'], 'it', 'female'),
	...namedVoices(['im_nicola'], 'it', 'male'),
	...namedVoices(['pf_dora'], 'pt-br', 'female'),
	...namedVoices(['pm_alex', 'pm_santa'], 'pt-br', 'male')
];

const WHISPER_FILTER = new HfModelFilter({
	libraryName: 'ctranslate2',
	task: 'automatic-speech-recognition'
});
const PARAKEET_FILTER = new HfModelFilter({
	modelName: 'istupakov/parakeet-tdt',
	task: 'automatic-speech-recognition'
});
const PIPER_FILTER = new HfModelFilter({
	libraryName: 'onnx',
	task: 'text-to-speech',
	tags: ['speaches', 'piper']
});
const KOKORO_FILTER = new HfModelFilter({
	libraryName: 'onnx',
	task: 'text-to-speech',
	tags: ['speaches', 'kokoro']
});

const PIPER_SAMPLE_RATES: Record<string, number> = {
	x_low: 16_000,
	low: 22_050,
	medium: 22_050,
	high: 22_050
};

function baseModel(repo: CachedRepoInfo, card: ModelCardData, task: ModelTask): CatalogModel {
	return {
		id: repo.id.name,
		created: Math.trunc(repo.lastModifiedAt.getTime() / 1000),
		object: 'model',
		owned_by: repo.id.name.split('/')[0]!,
		language: extractLanguageList(card),
		task
	};
}

function piperModel(repo: CachedRepoInfo, card: ModelCardData): CatalogModel | undefined {
	const parts = repo.id.name.split('/').at(-1)?.split('-') ?? [];
	if (parts.length !== 4) return undefined;
	const [, , name, quality] = parts;
	const sampleRate = PIPER_SAMPLE_RATES[quality!];
	const languages = extractLanguageList(card);
	if (name === undefined || sampleRate === undefined || languages.length !== 1) return undefined;
	return {
		...baseModel(repo, card, 'text-to-speech'),
		sample_rate: sampleRate,
		voices: namedVoices([name], languages[0]!)
	};
}

export function modelsForCachedRepo(repo: CachedRepoInfo, card: ModelCardData): CatalogModel[] {
	if (WHISPER_FILTER.passesFilter(repo.id.name, card)) {
		return [baseModel(repo, card, 'automatic-speech-recognition')];
	}
	if (PARAKEET_FILTER.passesFilter(repo.id.name, card)) {
		return [baseModel(repo, card, 'automatic-speech-recognition')];
	}
	if (PIPER_FILTER.passesFilter(repo.id.name, card)) {
		const model = piperModel(repo, card);
		return model === undefined ? [] : [model];
	}
	if (KOKORO_FILTER.passesFilter(repo.id.name, card)) {
		return [
			{
				...baseModel(repo, card, 'text-to-speech'),
				sample_rate: 24_000,
				voices: KOKORO_VOICES
			}
		];
	}
	if (repo.id.name === 'pyannote/wespeaker-voxceleb-resnet34-LM') {
		return [baseModel(repo, card, 'speaker-embedding')];
	}
	if (repo.id.name === 'pyannote/speaker-diarization-community-1') {
		return [baseModel(repo, card, 'speaker-diarization')];
	}
	return [];
}

export async function listLocalModels(cacheDir?: string): Promise<CatalogModel[]> {
	const models: CatalogModel[] = [];
	for (const repo of await getCachedModelReposInfo(cacheDir)) {
		const card = await getModelCardDataFromCachedRepoInfo(repo);
		if (card !== undefined) models.push(...modelsForCachedRepo(repo, card));
	}

	// Silero is bundled with the inference runtime rather than stored in the HF cache.
	models.push({
		id: 'silero_vad_v5',
		created: 0,
		object: 'model',
		owned_by: 'snakers4',
		language: null,
		task: 'voice-activity-detection'
	});
	return models;
}

export async function listLocalModelsByTask(
	task: ModelTask | undefined,
	cacheDir?: string
): Promise<CatalogModel[]> {
	const models = await listLocalModels(cacheDir);
	return task === undefined ? models : models.filter((model) => model.task === task);
}

export async function listLocalAudioModels(cacheDir?: string): Promise<CatalogModel[]> {
	return listLocalModelsByTask('text-to-speech', cacheDir);
}

export async function listLocalVoices(cacheDir?: string): Promise<CatalogVoice[]> {
	return (await listLocalAudioModels(cacheDir)).flatMap((model) => model.voices ?? []);
}
