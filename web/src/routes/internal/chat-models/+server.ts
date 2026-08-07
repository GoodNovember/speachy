import type { RequestHandler } from './$types';
import { getConfig } from '$lib/server/runtime';
import { createLogger } from '$lib/server/logger';

const logger = createLogger('internal.chat-models');

// Not part of the OpenAI-compatible surface, hence /internal rather than /v1.
// The chat backend (Ollama, LM Studio, anything else) is a separate service
// from the speech server, and the browser should not have to reach it directly
// or know where it lives.
export const GET: RequestHandler = async () => {
	const config = getConfig();
	const target = new URL('models', `${config.chatCompletionBaseUrl.replace(/\/?$/, '/')}`);

	try {
		const response = await fetch(target, {
			headers: { authorization: `Bearer ${config.chatCompletionApiKey}` },
			signal: AbortSignal.timeout(5000)
		});
		if (!response.ok) {
			return Response.json(
				{
					detail: `Chat backend returned ${response.status}`,
					baseUrl: config.chatCompletionBaseUrl
				},
				{ status: 502 }
			);
		}
		const body = (await response.json()) as { data?: { id?: string }[] };
		const models = (body.data ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === 'string')
			.sort();
		return Response.json({ models, baseUrl: config.chatCompletionBaseUrl });
	} catch (error) {
		logger.exception(`Chat backend unreachable at ${config.chatCompletionBaseUrl}`, error);
		return Response.json(
			{
				detail: `Cannot reach a chat backend at ${config.chatCompletionBaseUrl}. Start Ollama or LM Studio, or point CHAT_COMPLETION_BASE_URL somewhere else.`,
				baseUrl: config.chatCompletionBaseUrl
			},
			{ status: 502 }
		);
	}
};
