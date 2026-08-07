import { WebSocket } from 'ws';

// Phase 0 acceptance check: the page renders and the realtime socket completes
// a round trip. Point it at either the dev server or the built server.
//   node scripts/smoke.mjs http://127.0.0.1:8123

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const failures = [];

function check(name, ok, detail = '') {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures.push(name);
}

const response = await fetch(new URL('/', base));
const body = await response.text();
check('page responds 200', response.status === 200, `status=${response.status}`);
check('page is rendered html', body.includes('Phase 0'));

const socketUrl = new URL('/v1/realtime', base);
socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
socketUrl.searchParams.set('model', 'smoke');

const received = [];
await new Promise((resolve) => {
	const socket = new WebSocket(socketUrl);
	const timer = setTimeout(() => {
		socket.terminate();
		resolve();
	}, 8000);

	socket.on('open', () => socket.send(JSON.stringify({ type: 'session.update' })));
	socket.on('message', (data) => {
		const event = JSON.parse(data.toString());
		received.push(event);
		if (event.type === 'transport.echo') {
			clearTimeout(timer);
			socket.close();
		}
	});
	socket.on('error', (error) => {
		received.push({ type: 'error', message: error.message });
		clearTimeout(timer);
		resolve();
	});
	socket.on('close', () => {
		clearTimeout(timer);
		resolve();
	});
});

check(
	'socket sends transport.ready on connect',
	received.some((event) => event.type === 'transport.ready')
);
check(
	'socket round-trips a client event',
	received.some(
		(event) => event.type === 'transport.echo' && event.echoed_type === 'session.update'
	)
);

if (failures.length > 0) {
	console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
	process.exit(1);
}
console.log('\nAll smoke checks passed.');
