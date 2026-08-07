import { loadConfig, redactConfig } from './config.ts';
import { createLogger, setLogLevel } from './logger.ts';
import { getRuntime, hasRuntime, setRuntime, type Runtime } from './runtime.ts';

// Runs once per process, before the first request. SvelteKit has no lifespan
// hook, so both the production server and the dev plugin call this and the
// second call is a no-op.
export function bootstrap(env: Record<string, string | undefined> = process.env): Runtime {
	if (hasRuntime()) return getRuntime();

	const config = loadConfig(env);
	setLogLevel(config.logLevel);

	const runtime: Runtime = { config, startedAt: Date.now() };
	setRuntime(runtime);

	const logger = createLogger('bootstrap');
	logger.debug('Configuration loaded', redactConfig(config));
	logger.info(`Speachy runtime initialised on ${config.host}:${config.port}`);

	return runtime;
}
