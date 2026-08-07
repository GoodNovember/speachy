import type { Handle } from '@sveltejs/kit';
import { bootstrap } from '$lib/server/bootstrap';
import { createServerHandle } from '$lib/server/middleware';

const runtime = bootstrap();

export const handle: Handle = createServerHandle(runtime.config);
