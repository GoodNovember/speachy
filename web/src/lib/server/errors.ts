export type APIProxyErrorOptions = {
	hint?: string;
	suggestions?: string[];
	status?: number;
	debug?: unknown;
};

export class APIProxyError extends Error {
	readonly hint: string | undefined;
	readonly suggestions: string[];
	readonly status: number;
	readonly debug: unknown;

	constructor(message: string, options: APIProxyErrorOptions = {}) {
		super(message);
		this.name = 'APIProxyError';
		this.hint = options.hint;
		this.suggestions = options.suggestions ?? [];
		this.status = options.status ?? 500;
		this.debug = options.debug;
	}
}
