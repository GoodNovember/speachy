import type { CachedRepoInfo } from '@huggingface/hub';
import { describe, expect, it } from 'vitest';
import { KOKORO_VOICES, modelForRemoteInfo, modelsForCachedRepo } from './model-catalog.ts';

function repo(name: string): CachedRepoInfo {
	return {
		id: { name, type: 'model' },
		path: `/cache/models--${name.replaceAll('/', '--')}`,
		size: 0,
		filesCount: 0,
		revisions: [],
		lastAccessedAt: new Date('2026-01-01T00:00:00Z'),
		lastModifiedAt: new Date('2026-02-03T04:05:06Z')
	};
}

describe('model catalog classification', () => {
	it('classifies CTranslate2 Whisper metadata', () => {
		expect(
			modelsForCachedRepo(repo('Systran/faster-whisper-tiny'), {
				library_name: 'ctranslate2',
				pipeline_tag: 'automatic-speech-recognition',
				language: ['en', 'fr']
			})
		).toEqual([
			expect.objectContaining({
				id: 'Systran/faster-whisper-tiny',
				owned_by: 'Systran',
				language: ['en', 'fr'],
				task: 'automatic-speech-recognition'
			})
		]);
	});

	it('decorates Kokoro with the complete voice catalog', () => {
		const [model] = modelsForCachedRepo(repo('speaches-ai/Kokoro-82M-v1.0-ONNX'), {
			library_name: 'onnx',
			pipeline_tag: 'text-to-speech',
			tags: ['speaches', 'kokoro'],
			language: 'multilingual'
		});
		expect(model).toMatchObject({ sample_rate: 24_000, task: 'text-to-speech' });
		expect(model?.voices).toEqual(KOKORO_VOICES);
		expect(KOKORO_VOICES).toHaveLength(54);
		expect(KOKORO_VOICES[0]).toEqual({
			id: 'af_heart',
			name: 'af_heart',
			language: 'en-us',
			gender: 'female'
		});
	});

	it('derives Piper voice and sample-rate metadata from its repository name', () => {
		const [model] = modelsForCachedRepo(repo('speaches-ai/piper-en_US-amy-low'), {
			library_name: 'onnx',
			pipeline_tag: 'text-to-speech',
			tags: ['speaches', 'piper'],
			language: ['en-us']
		});
		expect(model).toMatchObject({
			sample_rate: 22_050,
			voices: [{ id: 'amy', name: 'amy', language: 'en-us' }]
		});
	});

	it('ignores unrelated cached repositories', () => {
		expect(modelsForCachedRepo(repo('org/unrelated'), { tags: ['text-to-speech'] })).toEqual([]);
	});

	it('maps remote metadata with the executor-specific response shape', () => {
		const createdAt = new Date('2025-01-02T03:04:05Z');
		const whisper = modelForRemoteInfo(
			{
				id: 'Systran/faster-whisper-small',
				createdAt,
				cardData: { language: ['en', 'fr'] }
			},
			'whisper'
		);
		expect(whisper).toMatchObject({
			id: 'Systran/faster-whisper-small',
			created: 1735787045,
			owned_by: 'Systran',
			language: ['en', 'fr'],
			task: 'automatic-speech-recognition'
		});

		const malformedPiper = modelForRemoteInfo(
			{ id: 'org/not-a-piper-name', createdAt, cardData: { language: 'en' } },
			'piper'
		);
		expect(malformedPiper).toBeUndefined();
	});
});
