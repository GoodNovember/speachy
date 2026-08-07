import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '../logger.ts';

const logger = createLogger('realtime.socket');

export const REALTIME_PATH = '/v1/realtime';

// Structural rather than http.Server, because Vite's dev server may be an
// Http2SecureServer and both satisfy what we need.
export type UpgradableServer = {
	on(
		event: 'upgrade',
		listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void
	): unknown;
};

let wss: WebSocketServer | undefined;

// Phase 0 only proves the transport survives dev and production builds. The
// session, event router, and pub/sub arrive in Phase 3 and replace the body of
// handleConnection without touching the attachment logic.
export function attachRealtimeServer(server: UpgradableServer): void {
	if (wss !== undefined) return;
	wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (request, socket, head) => {
		let pathname: string;
		try {
			pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
		} catch {
			return;
		}
		// Anything that is not ours is left alone so Vite's HMR socket still works
		// in dev. Destroying the socket here would break it.
		if (pathname !== REALTIME_PATH) return;
		wss!.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, request));
	});

	logger.info(`Realtime WebSocket listening on ${REALTIME_PATH}`);
}

export async function detachRealtimeServer(): Promise<void> {
	if (wss === undefined) return;
	const server = wss;
	wss = undefined;
	for (const client of server.clients) client.close(1001, 'Server shutting down');
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function handleConnection(ws: WebSocket, request: IncomingMessage): void {
	const url = new URL(request.url ?? '/', 'http://localhost');
	const model = url.searchParams.get('model') ?? undefined;
	const sessionId = `sess_${Math.random().toString(36).slice(2, 12)}`;

	logger.info(`Realtime connection opened: ${sessionId}`, { model });

	const send = (event: Record<string, unknown>): void => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
	};

	send({ type: 'transport.ready', session_id: sessionId, model, phase: 0 });

	ws.on('message', (data) => {
		let event: unknown;
		try {
			event = JSON.parse(data.toString());
		} catch {
			send({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
			return;
		}
		const type =
			typeof event === 'object' && event !== null && 'type' in event
				? String((event as { type: unknown }).type)
				: 'unknown';
		send({ type: 'transport.echo', echoed_type: type, received_at: Date.now() });
	});

	ws.on('close', () => logger.info(`Realtime connection closed: ${sessionId}`));
	ws.on('error', (error) => logger.exception(`Realtime connection error: ${sessionId}`, error));
}
