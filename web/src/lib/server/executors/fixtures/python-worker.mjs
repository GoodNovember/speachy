import process from 'node:process';

let buffer = '';
const timers = new Map();

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function accept(message) {
	if (message.type === 'cancel') {
		const timer = timers.get(message.id);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(message.id);
			send({
				id: message.id,
				type: 'error',
				error: { code: 'request_cancelled', message: 'Request cancelled by caller' }
			});
		}
		return;
	}

	if (message.method === 'ping') {
		send({
			id: message.id,
			type: 'result',
			result: {
				protocol_version: Number(process.env.SPEACHY_FIXTURE_PROTOCOL_VERSION ?? 1),
				pid: process.pid
			}
		});
		return;
	}
	if (message.method === 'list_loaded') {
		send({ id: message.id, type: 'result', result: { models: [] } });
		return;
	}
	if (message.method === 'events') {
		send({ id: message.id, type: 'event', event: { index: 0 } });
		send({ id: message.id, type: 'event', event: { index: 1 } });
		send({ id: message.id, type: 'result', result: 'done' });
		return;
	}
	if (message.method === 'fail') {
		send({
			id: message.id,
			type: 'error',
			error: { code: 'fixture_failure', message: 'failed on purpose', data: { retryable: false } }
		});
		return;
	}
	if (message.method === 'wait') {
		timers.set(
			message.id,
			setTimeout(() => {
				timers.delete(message.id);
				send({ id: message.id, type: 'result', result: 'late' });
			}, message.params.ms)
		);
		return;
	}
	send({
		id: message.id,
		type: 'error',
		error: { code: 'method_not_found', message: `Unknown method: ${message.method}` }
	});
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf('\n');
		if (newline === -1) break;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) accept(JSON.parse(line));
	}
});
