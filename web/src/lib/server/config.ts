import { z } from 'zod';
import { LOG_LEVELS } from './logger.ts';

const DEVICES = ['cpu', 'cuda', 'auto'] as const;

// https://github.com/OpenNMT/CTranslate2/blob/master/docs/quantization.md
const QUANTIZATIONS = [
	'int8',
	'int8_float16',
	'int8_bfloat16',
	'int8_float32',
	'int16',
	'float16',
	'bfloat16',
	'float32',
	'default'
] as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

const envBoolean = z.preprocess((value) => {
	if (typeof value !== 'string') return value;
	const normalised = value.trim().toLowerCase();
	if (TRUTHY.has(normalised)) return true;
	if (FALSY.has(normalised)) return false;
	return value;
}, z.boolean());

// Accepts both the JSON form pydantic-settings requires (`["a","b"]`) and a
// plain comma-separated list, so existing compose files keep working.
const envStringList = z.preprocess((value) => {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (trimmed === '') return [];
	if (trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return trimmed
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}, z.array(z.string()));

const envRecord = z.preprocess(
	(value) => {
		if (typeof value !== 'string') return value;
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	},
	z.record(z.string(), z.unknown())
);

const whisperSchema = z.object({
	inferenceDevice: z.enum(DEVICES).default('auto'),
	deviceIndex: z.coerce.number().int().default(0),
	computeType: z.enum(QUANTIZATIONS).default('default'),
	cpuThreads: z.coerce.number().int().min(0).default(0),
	numWorkers: z.coerce.number().int().min(1).default(1)
});

const ortOptionsSchema = z.object({
	excludeProviders: envStringList.default(['TensorrtExecutionProvider']),
	providerPriority: envRecord.default({ CUDAExecutionProvider: 100 }),
	providerOpts: envRecord.default({})
});

// ttl semantics match the Python original: -1 never unloads, 0 unloads
// immediately after the last release, > 0 unloads after that many seconds idle.
const ttl = z.coerce.number().int().min(-1);

export const configSchema = z.object({
	sttModelTtl: ttl.default(300),
	ttsModelTtl: ttl.default(300),
	vadModelTtl: ttl.default(-1),

	apiKey: z.string().min(1).optional(),
	logLevel: z.enum(LOG_LEVELS).default('info'),

	host: z.string().default('0.0.0.0'),
	port: z.coerce.number().int().min(1).max(65535).default(8000),
	allowOrigins: envStringList.optional(),

	// prefault, not default: zod returns a default value verbatim, so nested
	// field defaults would be skipped and whisper would parse as {}.
	whisper: whisperSchema.prefault({}),
	unstableOrtOpts: ortOptionsSchema.prefault({}),

	chatCompletionBaseUrl: z.string().url().default('http://localhost:11434/v1'),
	chatCompletionApiKey: z.string().default('cant-be-empty'),

	// Phase 1 only. The app proxies /v1/* here so the browser talks to one
	// origin and the UI is written against the paths our own server will serve
	// in Phase 2. Each proxied route gets replaced by a real handler in place.
	referenceBaseUrl: z.string().url().default('http://127.0.0.1:8001'),

	preloadModels: envStringList.default([]),

	otelExporterOtlpEndpoint: z.string().url().optional(),
	otelServiceName: z.string().default('speachy'),

	// Inference worker threads per executor. Native inference calls block the
	// thread they run on, so this is a hard concurrency limit, not a hint.
	inferenceWorkers: z.coerce.number().int().min(1).default(1),

	unstableVadFilter: envBoolean.default(true)
});

export type Config = z.infer<typeof configSchema>;

function toCamelCase(segment: string): string {
	return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

// pydantic-settings maps WHISPER__COMPUTE_TYPE onto whisper.compute_type via
// env_nested_delimiter. Reproduce that, then camel-case each segment.
export function unflattenEnv(env: Record<string, string | undefined>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const path = key.split('__').filter(Boolean).map(toCamelCase);
		if (path.length === 0) continue;
		let node = result;
		for (const segment of path.slice(0, -1)) {
			const existing = node[segment];
			if (typeof existing !== 'object' || existing === null) node[segment] = {};
			node = node[segment] as Record<string, unknown>;
		}
		node[path[path.length - 1]!] = value;
	}
	return result;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
	const raw = unflattenEnv(env);

	// UVICORN_HOST and UVICORN_PORT are what the Python deployment docs and the
	// compose files use; accept them so existing setups do not have to change.
	if (raw.host === undefined && env.UVICORN_HOST !== undefined) raw.host = env.UVICORN_HOST;
	if (raw.port === undefined && env.UVICORN_PORT !== undefined) raw.port = env.UVICORN_PORT;

	const parsed = configSchema.safeParse(raw);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
			.join('\n');
		throw new Error(`Invalid configuration:\n${issues}`);
	}
	return parsed.data;
}

export function redactConfig(config: Config): Record<string, unknown> {
	return {
		...config,
		apiKey: config.apiKey === undefined ? undefined : '***',
		chatCompletionApiKey: '***'
	};
}
