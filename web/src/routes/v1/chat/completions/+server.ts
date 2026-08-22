import type { RequestHandler } from './$types';
import { createChatResponse, invalidChatJsonResponse } from '$lib/server/chat-http';

export { createChatResponse as _chatResponse } from '$lib/server/chat-http';

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return invalidChatJsonResponse();
	}
	return createChatResponse(body, request.signal);
};
