import type { Config } from './config.ts';

// The production server and SvelteKit's request handler are built as separate
// bundles, so a plain module-level singleton would be instantiated twice. A
// registered symbol on globalThis is the one slot both bundles resolve to.
const RUNTIME_KEY = Symbol.for('speachy.runtime');

export type Runtime = {
	config: Config;
	startedAt: number;
};

type RuntimeHost = typeof globalThis & { [RUNTIME_KEY]?: Runtime };

export function setRuntime(runtime: Runtime): void {
	(globalThis as RuntimeHost)[RUNTIME_KEY] = runtime;
}

export function getRuntime(): Runtime {
	const runtime = (globalThis as RuntimeHost)[RUNTIME_KEY];
	if (runtime === undefined) {
		throw new Error('Runtime is not initialised. bootstrap() must run before the first request.');
	}
	return runtime;
}

export function hasRuntime(): boolean {
	return (globalThis as RuntimeHost)[RUNTIME_KEY] !== undefined;
}

export function getConfig(): Config {
	return getRuntime().config;
}
