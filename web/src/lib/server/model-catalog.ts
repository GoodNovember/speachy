import type { CachedRepoInfo } from '@huggingface/hub';
import type { Model, ModelTask, Voice } from '$lib/types/api';
import { loadConfig, type Config } from './config.ts';
import {
	hasSherpaDiarizationModel,
	resolveSherpaDiarizationModelPaths,
	SHERPA_DIARIZATION_MODEL_ID,
	sherpaDiarizationCreatedAt
} from './native-diarization.ts';
import {
	hasSherpaParakeetModel,
	resolveSherpaParakeetModelPaths,
	SHERPA_PARAKEET_MODEL_ID,
	sherpaParakeetCreatedAt
} from './native-parakeet.ts';
import {
	hasSherpaWhisperModel,
	resolveSherpaWhisperModelPaths,
	SHERPA_WHISPER_MODEL_ID,
	sherpaWhisperCreatedAt
} from './native-whisper.ts';
import { getConfig, hasRuntime } from './runtime.ts';
import {
	extractLanguageList,
	getCachedModelReposInfo,
	getModelCardDataFromCachedRepoInfo,
	HfModelFilter,
	listRemoteModels,
	type ModelCardData,
	type RemoteModelInfo
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
	return modelFromMetadata(repo.id.name, repo.lastModifiedAt, card, task);
}

function modelFromMetadata(
	id: string,
	createdAt: Date,
	card: ModelCardData,
	task: ModelTask
): CatalogModel {
	return {
		id,
		created: Math.trunc(createdAt.getTime() / 1000),
		object: 'model',
		owned_by: id.split('/')[0]!,
		language: extractLanguageList(card),
		task
	};
}

function piperModel(id: string, createdAt: Date, card: ModelCardData): CatalogModel | undefined {
	const parts = id.split('/').at(-1)?.split('-') ?? [];
	if (parts.length !== 4) return undefined;
	const [, , name, quality] = parts;
	const sampleRate = PIPER_SAMPLE_RATES[quality!];
	const languages = extractLanguageList(card);
	if (name === undefined || sampleRate === undefined || languages.length !== 1) return undefined;
	return {
		...modelFromMetadata(id, createdAt, card, 'text-to-speech'),
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
		const model = piperModel(repo.id.name, repo.lastModifiedAt, card);
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

export type RemoteCatalogKind = 'whisper' | 'parakeet' | 'piper' | 'kokoro';

export function remoteCatalogKindForMetadata(
	modelId: string,
	card: ModelCardData
): RemoteCatalogKind | undefined {
	if (WHISPER_FILTER.passesFilter(modelId, card)) return 'whisper';
	if (PARAKEET_FILTER.passesFilter(modelId, card)) return 'parakeet';
	if (PIPER_FILTER.passesFilter(modelId, card)) return 'piper';
	if (KOKORO_FILTER.passesFilter(modelId, card)) return 'kokoro';
	return undefined;
}

export function modelForRemoteInfo(
	info: RemoteModelInfo,
	kind: RemoteCatalogKind
): CatalogModel | undefined {
	if (kind === 'piper') return piperModel(info.id, info.createdAt, info.cardData);
	const task =
		kind === 'whisper' || kind === 'parakeet' ? 'automatic-speech-recognition' : 'text-to-speech';
	const model = modelFromMetadata(info.id, info.createdAt, info.cardData, task);
	return kind === 'kokoro' ? { ...model, sample_rate: 24_000, voices: KOKORO_VOICES } : model;
}

const REMOTE_SOURCES: Array<{
	kind: RemoteCatalogKind;
	task: ModelTask;
	filter: HfModelFilter;
}> = [
	{ kind: 'whisper', task: 'automatic-speech-recognition', filter: WHISPER_FILTER },
	{ kind: 'parakeet', task: 'automatic-speech-recognition', filter: PARAKEET_FILTER },
	{ kind: 'piper', task: 'text-to-speech', filter: PIPER_FILTER },
	{ kind: 'kokoro', task: 'text-to-speech', filter: KOKORO_FILTER }
];

const STATIC_REMOTE_MODELS: CatalogModel[] = [
	{
		id: 'pyannote/wespeaker-voxceleb-resnet34-LM',
		created: 0,
		object: 'model',
		owned_by: 'pyannote',
		language: null,
		task: 'speaker-embedding'
	},
	{
		id: 'pyannote/speaker-diarization-community-1',
		created: 0,
		object: 'model',
		owned_by: 'pyannote',
		language: null,
		task: 'speaker-diarization'
	}
];

export async function listRemoteCatalogModelsByTask(task?: ModelTask): Promise<CatalogModel[]> {
	const models: CatalogModel[] = [];
	const accessToken = process.env.HF_TOKEN;
	for (const source of REMOTE_SOURCES) {
		if (task !== undefined && source.task !== task) continue;
		for await (const info of listRemoteModels(source.filter, { accessToken })) {
			const model = modelForRemoteInfo(info, source.kind);
			if (model !== undefined) models.push(model);
		}
	}
	models.push(...STATIC_REMOTE_MODELS.filter((model) => task === undefined || model.task === task));
	return models;
}

export async function listLocalModels(cacheDir?: string): Promise<CatalogModel[]> {
	const models: CatalogModel[] = [];
	const backend: Config['inferenceBackend'] =
		cacheDir !== undefined
			? 'hybrid'
			: hasRuntime()
				? getConfig().inferenceBackend
				: loadConfig(process.env).inferenceBackend;
	if (backend !== 'native') {
		for (const repo of await getCachedModelReposInfo(cacheDir)) {
			const card = await getModelCardDataFromCachedRepoInfo(repo);
			if (card !== undefined) models.push(...modelsForCachedRepo(repo, card));
		}
	}
	if (cacheDir === undefined && backend !== 'python') {
		const nativeWhisper = resolveSherpaWhisperModelPaths();
		if (hasSherpaWhisperModel(nativeWhisper)) {
			models.push({
				id: SHERPA_WHISPER_MODEL_ID,
				created: await sherpaWhisperCreatedAt(nativeWhisper),
				object: 'model',
				owned_by: 'sherpa-onnx',
				language: ['en'],
				task: 'automatic-speech-recognition'
			});
		}
		const nativeParakeet = resolveSherpaParakeetModelPaths();
		if (hasSherpaParakeetModel(nativeParakeet)) {
			models.push({
				id: SHERPA_PARAKEET_MODEL_ID,
				created: await sherpaParakeetCreatedAt(nativeParakeet),
				object: 'model',
				owned_by: 'sherpa-onnx',
				language: ['en'],
				task: 'automatic-speech-recognition'
			});
		}
		const nativeDiarization = resolveSherpaDiarizationModelPaths();
		if (hasSherpaDiarizationModel(nativeDiarization)) {
			models.push({
				id: SHERPA_DIARIZATION_MODEL_ID,
				created: await sherpaDiarizationCreatedAt(nativeDiarization),
				object: 'model',
				owned_by: 'sherpa-onnx',
				language: ['en'],
				task: 'speaker-diarization'
			});
		}
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
