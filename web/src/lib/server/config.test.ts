import { describe, expect, it } from 'vitest';
import { loadConfig, unflattenEnv } from './config.ts';

describe('unflattenEnv', () => {
	it('camel-cases flat keys', () => {
		expect(unflattenEnv({ STT_MODEL_TTL: '60' })).toEqual({ sttModelTtl: '60' });
	});

	it('nests on the double-underscore delimiter like pydantic-settings', () => {
		expect(unflattenEnv({ WHISPER__COMPUTE_TYPE: 'int8' })).toEqual({
			whisper: { computeType: 'int8' }
		});
	});

	it('merges several keys under one parent', () => {
		expect(unflattenEnv({ WHISPER__COMPUTE_TYPE: 'int8', WHISPER__CPU_THREADS: '4' })).toEqual({
			whisper: { computeType: 'int8', cpuThreads: '4' }
		});
	});

	it('skips undefined values', () => {
		expect(unflattenEnv({ LOG_LEVEL: undefined })).toEqual({});
	});
});

describe('loadConfig', () => {
	it('applies the Python defaults', () => {
		const config = loadConfig({});
		expect(config.sttModelTtl).toBe(300);
		expect(config.ttsModelTtl).toBe(300);
		expect(config.vadModelTtl).toBe(-1);
		expect(config.host).toBe('0.0.0.0');
		expect(config.port).toBe(8000);
		expect(config.whisper.inferenceDevice).toBe('auto');
		expect(config.whisper.computeType).toBe('default');
		expect(config.inferenceBackend).toBe('hybrid');
		expect(config.apiKey).toBeUndefined();
	});

	it('selects an explicit inference backend', () => {
		expect(loadConfig({ INFERENCE_BACKEND: 'native' }).inferenceBackend).toBe('native');
		expect(loadConfig({ INFERENCE_BACKEND: 'python' }).inferenceBackend).toBe('python');
	});

	it('coerces numeric and nested values', () => {
		const config = loadConfig({ STT_MODEL_TTL: '60', WHISPER__CPU_THREADS: '8' });
		expect(config.sttModelTtl).toBe(60);
		expect(config.whisper.cpuThreads).toBe(8);
	});

	it('accepts the JSON list form pydantic-settings requires', () => {
		const config = loadConfig({ ALLOW_ORIGINS: '["http://localhost:3000","*"]' });
		expect(config.allowOrigins).toEqual(['http://localhost:3000', '*']);
	});

	it('also accepts a comma-separated list', () => {
		const config = loadConfig({
			PRELOAD_MODELS: 'Systran/faster-whisper-tiny, rhasspy/piper-voices'
		});
		expect(config.preloadModels).toEqual(['Systran/faster-whisper-tiny', 'rhasspy/piper-voices']);
	});

	it('falls back to the uvicorn host and port names', () => {
		const config = loadConfig({ UVICORN_HOST: '127.0.0.1', UVICORN_PORT: '9000' });
		expect(config.host).toBe('127.0.0.1');
		expect(config.port).toBe(9000);
	});

	it('prefers HOST and PORT over the uvicorn names', () => {
		const config = loadConfig({ HOST: '10.0.0.1', UVICORN_HOST: '127.0.0.1' });
		expect(config.host).toBe('10.0.0.1');
	});

	it('ignores unrelated environment variables', () => {
		expect(() => loadConfig({ PATH: '/usr/bin', npm_package_name: 'web' })).not.toThrow();
	});

	it('rejects a ttl below -1', () => {
		expect(() => loadConfig({ STT_MODEL_TTL: '-5' })).toThrow(/sttModelTtl/);
	});

	it('rejects an unknown log level', () => {
		expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/logLevel/);
	});

	it('rejects an unknown inference backend', () => {
		expect(() => loadConfig({ INFERENCE_BACKEND: 'remote' })).toThrow(/inferenceBackend/);
	});
});
