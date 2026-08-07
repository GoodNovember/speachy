export const LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'critical'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warning: 30,
	error: 40,
	critical: 50
};

let threshold = SEVERITY.info;

export function setLogLevel(level: LogLevel): void {
	threshold = SEVERITY[level];
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
	if (SEVERITY[level] < threshold) return;
	const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(8)} ${scope} ${message}`;
	const stream = SEVERITY[level] >= SEVERITY.error ? console.error : console.log;
	if (detail === undefined) stream(line);
	else stream(line, detail);
}

export type Logger = {
	debug(message: string, detail?: unknown): void;
	info(message: string, detail?: unknown): void;
	warning(message: string, detail?: unknown): void;
	error(message: string, detail?: unknown): void;
	critical(message: string, detail?: unknown): void;
	exception(message: string, error: unknown): void;
};

export function createLogger(scope: string): Logger {
	return {
		debug: (message, detail) => emit('debug', scope, message, detail),
		info: (message, detail) => emit('info', scope, message, detail),
		warning: (message, detail) => emit('warning', scope, message, detail),
		error: (message, detail) => emit('error', scope, message, detail),
		critical: (message, detail) => emit('critical', scope, message, detail),
		exception: (message, error) =>
			emit('error', scope, message, error instanceof Error ? (error.stack ?? error) : error)
	};
}
