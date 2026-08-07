import { createHash, randomUUID } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';
import type { Config } from './config.ts';
import { APIProxyError } from './errors.ts';
import { createLogger } from './logger.ts';

const logger = createLogger('middleware');
const PROTECTED_PATH = /^\/(?:v1|api|internal)(?:\/|$)/;
const CORS_METHODS = 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT';

const AUTH_REQUIRED =
	'API key required. Please provide an API key using the Authorization header with Bearer scheme.';
const AUTH_INVALID = 'Invalid API key. The provided API key is incorrect.';

function keysMatch(provided: string, expected: string): boolean {
	const providedDigest = createHash('sha256').update(provided).digest();
	const expectedDigest = createHash('sha256').update(expected).digest();
	return providedDigest.equals(expectedDigest);
}

function authFailure(detail: string): Response {
	return Response.json(
		{ detail },
		{
			status: 403,
			headers: { 'www-authenticate': 'Bearer' }
		}
	);
}

function corsOrigin(request: Request, config: Config): string | undefined {
	const origin = request.headers.get('origin');
	if (origin === null || config.allowOrigins === undefined) return undefined;
	return config.allowOrigins.includes('*') || config.allowOrigins.includes(origin)
		? origin
		: undefined;
}

function withCors(response: Response, origin: string | undefined): Response {
	if (origin === undefined) return response;
	const headers = new Headers(response.headers);
	headers.set('access-control-allow-origin', origin);
	headers.set('access-control-allow-credentials', 'true');
	headers.append('vary', 'Origin');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

function preflight(request: Request, config: Config): Response | undefined {
	if (
		config.allowOrigins === undefined ||
		request.method !== 'OPTIONS' ||
		request.headers.get('access-control-request-method') === null
	) {
		return undefined;
	}

	const origin = corsOrigin(request, config);
	if (origin === undefined) return new Response('Disallowed CORS origin', { status: 400 });

	const headers = new Headers({
		'access-control-allow-origin': origin,
		'access-control-allow-credentials': 'true',
		'access-control-allow-methods': CORS_METHODS,
		'access-control-max-age': '600',
		vary: 'Origin'
	});
	const requestedHeaders = request.headers.get('access-control-request-headers');
	if (requestedHeaders !== null) headers.set('access-control-allow-headers', requestedHeaders);
	return new Response('OK', { status: 200, headers });
}

function proxyErrorResponse(error: APIProxyError, config: Config): Response {
	const errorId = randomUUID();
	logger.exception(`[${errorId}] ${error.message}`, error);
	return Response.json(
		{
			detail: error.message,
			hint: error.hint,
			suggested_fixes: error.suggestions,
			error_id: errorId,
			...(config.logLevel === 'debug' && error.debug !== undefined ? { debug: error.debug } : {})
		},
		{ status: error.status }
	);
}

export function createServerHandle(config: Config): Handle {
	return async ({ event, resolve }) => {
		event.locals.config = config;
		const origin = corsOrigin(event.request, config);
		const preflightResponse = preflight(event.request, config);
		if (preflightResponse !== undefined) return preflightResponse;

		if (config.apiKey !== undefined && PROTECTED_PATH.test(event.url.pathname)) {
			const authorization = event.request.headers.get('authorization');
			if (authorization === null || !authorization.startsWith('Bearer ')) {
				return withCors(authFailure(AUTH_REQUIRED), origin);
			}
			if (!keysMatch(authorization.slice('Bearer '.length), config.apiKey)) {
				return withCors(authFailure(AUTH_INVALID), origin);
			}
		}

		try {
			return withCors(await resolve(event), origin);
		} catch (error) {
			if (error instanceof APIProxyError)
				return withCors(proxyErrorResponse(error, config), origin);
			throw error;
		}
	};
}
