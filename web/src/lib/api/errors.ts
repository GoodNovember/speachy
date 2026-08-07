// The reference returns FastAPI's error shapes, not OpenAI's error envelope:
// a 404 gives {"detail": "..."} and a validation failure gives
// {"detail": [{type, loc, msg, input}, ...]}. Normalise both into one thing the
// UI can render, and keep tolerating OpenAI's shape for when Phase 2 lands.

export type FieldIssue = { field: string; message: string };

export class ApiError extends Error {
	readonly status: number;
	readonly issues: FieldIssue[];
	readonly hint?: string;
	readonly suggestions?: string[];

	constructor(
		message: string,
		status: number,
		options: { issues?: FieldIssue[]; hint?: string; suggestions?: string[] } = {}
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.issues = options.issues ?? [];
		this.hint = options.hint;
		this.suggestions = options.suggestions;
	}
}

type ValidationIssue = { loc?: unknown[]; msg?: string };

function isValidationIssueArray(value: unknown): value is ValidationIssue[] {
	return (
		Array.isArray(value) &&
		value.every((item) => typeof item === 'object' && item !== null && 'msg' in item)
	);
}

export function parseErrorBody(body: unknown, status: number): ApiError {
	if (typeof body === 'string' && body.trim() !== '') {
		return new ApiError(body, status);
	}

	if (typeof body !== 'object' || body === null) {
		return new ApiError(`Request failed with status ${status}`, status);
	}

	const record = body as Record<string, unknown>;

	// APIProxyError from the chat endpoint carries extra guidance worth keeping.
	const hint = typeof record.hint === 'string' ? record.hint : undefined;
	const suggestions = Array.isArray(record.suggested_fixes)
		? record.suggested_fixes.filter((s): s is string => typeof s === 'string')
		: undefined;

	const detail = record.detail;

	if (typeof detail === 'string') {
		return new ApiError(detail, status, { hint, suggestions });
	}

	if (isValidationIssueArray(detail)) {
		const issues = detail.map((issue) => ({
			// loc is like ["body", "model"]; the first element is the request part.
			field: Array.isArray(issue.loc) ? issue.loc.slice(1).join('.') || 'request' : 'request',
			message: issue.msg ?? 'Invalid value'
		}));
		const summary = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
		return new ApiError(summary || `Request failed with status ${status}`, status, {
			issues,
			hint,
			suggestions
		});
	}

	// OpenAI's shape, for when our own server takes over.
	const error = record.error;
	if (typeof error === 'object' && error !== null) {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === 'string') return new ApiError(message, status, { hint, suggestions });
	}

	return new ApiError(`Request failed with status ${status}`, status, { hint, suggestions });
}

export async function errorFromResponse(response: Response): Promise<ApiError> {
	const text = await response.text().catch(() => '');
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON; keep the raw text
	}
	return parseErrorBody(body, response.status);
}
