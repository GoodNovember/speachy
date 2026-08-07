import { getConfig } from './runtime.ts';
import { createLogger } from './logger.ts';

const logger = createLogger('proxy');

// Headers that describe a single hop and must not be forwarded.
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'host',
	'content-length'
]);

function filterHeaders(source: Headers): Headers {
	const out = new Headers();
	for (const [key, value] of source) {
		if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
	}
	return out;
}

export async function proxyToReference(request: Request, pathname: string): Promise<Response> {
	const config = getConfig();
	const target = new URL(pathname + new URL(request.url).search, config.referenceBaseUrl);

	const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers: filterHeaders(request.headers),
			body: hasBody ? request.body : undefined,
			// Required by undici when streaming a request body through.
			...(hasBody ? { duplex: 'half' } : {})
		} as RequestInit);
	} catch (error) {
		logger.exception(`Reference server unreachable at ${target.origin}`, error);
		return Response.json(
			{
				detail: `Cannot reach the reference server at ${config.referenceBaseUrl}. Start it with 'pwsh web/scripts/run-reference.ps1'.`
			},
			{ status: 502 }
		);
	}

	// Pass the body straight through rather than buffering, so SSE and audio
	// streams still arrive incrementally.
	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: filterHeaders(upstream.headers)
	});
}
