import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../logger.ts';
import { getConfig } from '../runtime.ts';

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

// This WebSocket is the final reference-server bridge. Phase 3 replaces the
// body of handleConnection with the native session implementation and removes
// referenceBaseUrl entirely.
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

function handleConnection(client: WebSocket, request: IncomingMessage): void {
	const config = getConfig();
	const target = new URL(request.url ?? REALTIME_PATH, config.referenceBaseUrl);
	target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';

	logger.info(`Realtime connection opened, proxying to ${target.origin}${target.pathname}`);

	const headers: Record<string, string> = {};
	const auth = request.headers.authorization;
	if (auth !== undefined) headers.authorization = auth;

	const upstream = new WebSocket(target, { headers });

	// The browser can send before the upstream handshake finishes; hold those
	// frames rather than dropping them.
	const pending: Array<Buffer | string> = [];
	let upstreamReady = false;

	upstream.on('open', () => {
		upstreamReady = true;
		for (const message of pending) upstream.send(message);
		pending.length = 0;
	});

	upstream.on('message', (data, isBinary) => {
		if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
	});

	upstream.on('close', (code, reason) => {
		if (client.readyState === client.OPEN) {
			// 1005 means "no status" and cannot be sent back explicitly.
			client.close(code === 1005 ? 1000 : code, reason.toString());
		}
	});

	upstream.on('error', (error) => {
		logger.exception('Realtime upstream error', error);
		if (client.readyState === client.OPEN) {
			client.send(
				JSON.stringify({
					type: 'error',
					error: {
						type: 'server_error',
						message: `Cannot reach the reference server at ${config.referenceBaseUrl}. Start it with 'pwsh web/scripts/run-reference.ps1'.`
					}
				})
			);
			client.close(1011, 'Upstream unavailable');
		}
	});

	client.on('message', (data, isBinary) => {
		const message = isBinary ? (data as Buffer) : data.toString();
		if (upstreamReady && upstream.readyState === upstream.OPEN) upstream.send(message);
		else pending.push(message);
	});

	client.on('close', () => {
		if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) {
			upstream.close();
		}
		logger.info('Realtime connection closed');
	});

	client.on('error', (error) => logger.exception('Realtime client error', error));
}
