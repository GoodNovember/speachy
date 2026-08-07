import type { Handle } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { APIProxyError } from './errors.ts';
import { createServerHandle } from './middleware.ts';

type Resolve = Parameters<Handle>[0]['resolve'];

async function run(
	handle: Handle,
	path: string,
	init: RequestInit = {},
	resolve: Resolve = vi.fn(async () => Response.json({ ok: true }))
): Promise<Response> {
	const url = new URL(path, 'http://localhost');
	return handle({
		event: {
			url,
			request: new Request(url, init),
			locals: {}
		} as Parameters<Resolve>[0],
		resolve
	});
}

describe('API key authentication', () => {
	const authenticated = createServerHandle(loadConfig({ API_KEY: 'test-api-key-123' }));

	it.each(['/health', '/docs', '/openapi.json', '/'])(
		'leaves public path %s accessible',
		async (path) => {
			expect((await run(authenticated, path)).status).toBe(200);
		}
	);

	it.each(['/v1/models', '/api/ps', '/internal/chat-models'])(
		'protects API path %s',
		async (path) => {
			const response = await run(authenticated, path);
			expect(response.status).toBe(403);
			expect(response.headers.get('www-authenticate')).toBe('Bearer');
			expect(await response.json()).toEqual({
				detail:
					'API key required. Please provide an API key using the Authorization header with Bearer scheme.'
			});
		}
	);

	it.each(['test-api-key-123', 'Bearer wrong-api-key'])(
		'rejects malformed or incorrect authorization %s',
		async (authorization) => {
			const response = await run(authenticated, '/v1/models', {
				headers: { authorization }
			});
			expect(response.status).toBe(403);
		}
	);

	it('accepts the configured bearer key', async () => {
		const response = await run(authenticated, '/v1/models', {
			headers: { authorization: 'Bearer test-api-key-123' }
		});
		expect(response.status).toBe(200);
	});

	it('does not require authentication when no key is configured', async () => {
		const response = await run(createServerHandle(loadConfig({})), '/v1/models');
		expect(response.status).toBe(200);
	});
});

describe('CORS', () => {
	const handle = createServerHandle(
		loadConfig({ API_KEY: 'secret', ALLOW_ORIGINS: 'https://app.example' })
	);

	it('answers an allowed preflight before authentication', async () => {
		const response = await run(handle, '/v1/audio/transcriptions', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://app.example',
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'authorization,content-type'
			}
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
		expect(response.headers.get('access-control-allow-credentials')).toBe('true');
		expect(response.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
	});

	it('rejects a preflight from an unconfigured origin', async () => {
		const response = await run(handle, '/v1/models', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://wrong.example',
				'access-control-request-method': 'GET'
			}
		});
		expect(response.status).toBe(400);
	});

	it('leaves OPTIONS requests alone when CORS is disabled', async () => {
		const response = await run(createServerHandle(loadConfig({})), '/v1/models', {
			method: 'OPTIONS',
			headers: {
				origin: 'https://app.example',
				'access-control-request-method': 'GET'
			}
		});
		expect(response.status).toBe(200);
		expect(response.headers.has('access-control-allow-origin')).toBe(false);
	});

	it('adds CORS headers to an authenticated response', async () => {
		const response = await run(handle, '/v1/models', {
			headers: {
				origin: 'https://app.example',
				authorization: 'Bearer secret'
			}
		});
		expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
	});
});

describe('APIProxyError', () => {
	it('returns the structured public error shape', async () => {
		const handle = createServerHandle(loadConfig({}));
		const response = await run(handle, '/v1/chat/completions', {}, async () => {
			throw new APIProxyError('Backend failed', {
				hint: 'Check the backend',
				suggestions: ['Retry'],
				status: 502,
				debug: { secret: true }
			});
		});
		expect(response.status).toBe(502);
		const body = await response.json();
		expect(body).toMatchObject({
			detail: 'Backend failed',
			hint: 'Check the backend',
			suggested_fixes: ['Retry']
		});
		expect(body).not.toHaveProperty('debug');
	});

	it('includes debug details only at debug log level', async () => {
		const handle = createServerHandle(loadConfig({ LOG_LEVEL: 'debug' }));
		const response = await run(handle, '/v1/models', {}, async () => {
			throw new APIProxyError('Backend failed', { debug: { cause: 'offline' } });
		});
		expect((await response.json()).debug).toEqual({ cause: 'offline' });
	});
});
