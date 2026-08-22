import { describe, expect, it } from 'vitest';
import { GET as apiGet } from './api/[...path]/+server.ts';
import { GET as v1Get } from './v1/[...path]/+server.ts';

describe('native HTTP catch-alls', () => {
	it.each([
		['/v1/*', v1Get],
		['/api/*', apiGet]
	])('returns the compatibility not-found response for %s', async (_path, handler) => {
		const response = await handler({} as never);

		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toEqual({ detail: 'Not Found' });
	});
});
