import { expect, it } from 'vitest';
import { GET } from './+server.ts';

it('returns the public health response', async () => {
	const response = await GET({} as never);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ message: 'OK' });
});
