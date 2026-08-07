import type { Plugin } from 'vite';
import { bootstrap } from './src/lib/server/bootstrap.ts';
import { attachRealtimeServer } from './src/lib/server/realtime/socket.ts';

// In dev, Vite owns the HTTP server, so the realtime socket attaches here. In
// production it attaches in src/server-entry.ts. Both call the same function,
// and shared state travels through the globalThis runtime registry rather than
// module scope, because these are two separate bundles.
export function realtimeDev(): Plugin {
	return {
		name: 'speachy-realtime-dev',
		apply: 'serve',
		configureServer(server) {
			bootstrap();
			if (server.httpServer !== null) attachRealtimeServer(server.httpServer);
		}
	};
}
