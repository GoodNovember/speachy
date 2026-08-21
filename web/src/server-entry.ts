import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bootstrap } from './lib/server/bootstrap.ts';
import { closeInferenceWorker } from './lib/server/executors/python-runtime.ts';
import { createLogger } from './lib/server/logger.ts';
import { attachRealtimeServer, detachRealtimeServer } from './lib/server/realtime/socket.ts';

type SvelteKitHandler = (
	request: IncomingMessage,
	response: ServerResponse,
	next: () => void
) => void;

const runtime = bootstrap();
const logger = createLogger('server');

// adapter-node emits build/handler.js next to this bundle. The specifier is
// computed so neither TypeScript nor Vite tries to resolve it at build time.
const handlerUrl = new URL('../build/handler.js', import.meta.url).href;
const { handler } = (await import(/* @vite-ignore */ handlerUrl)) as { handler: SvelteKitHandler };

const server = createServer((request, response) => {
	handler(request, response, () => {
		response.statusCode = 404;
		response.setHeader('content-type', 'text/plain');
		response.end('Not Found');
	});
});

attachRealtimeServer(server);

server.listen(runtime.config.port, runtime.config.host, () => {
	logger.info(`Listening on http://${runtime.config.host}:${runtime.config.port}`);
});

async function shutdown(signal: string): Promise<void> {
	logger.info(`Received ${signal}, shutting down`);
	await detachRealtimeServer();
	await closeInferenceWorker(runtime);
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 10_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => void shutdown(signal));
}
