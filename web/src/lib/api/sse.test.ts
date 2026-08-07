import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.ts';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		}
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal
): Promise<string[]> {
	const out: string[] = [];
	for await (const value of parseSseStream(stream, signal)) out.push(value);
	return out;
}

describe('parseSseStream', () => {
	it('reads events separated by a blank line', async () => {
		await expect(collect(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n'))).resolves.toEqual([
			'{"a":1}',
			'{"a":2}'
		]);
	});

	it('ends at end of body, with no [DONE] sentinel', async () => {
		// This is the reference's actual behaviour. A parser that waits for the
		// sentinel hangs until the socket closes.
		await expect(collect(streamOf('data: {"a":1}\n\n'))).resolves.toEqual(['{"a":1}']);
	});

	it('still stops at [DONE] when one is present', async () => {
		await expect(
			collect(streamOf('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"a":2}\n\n'))
		).resolves.toEqual(['{"a":1}']);
	});

	it('reassembles an event split across chunks', async () => {
		await expect(collect(streamOf('data: {"a', '":1}\n', '\n'))).resolves.toEqual(['{"a":1}']);
	});

	it('handles several events arriving in one chunk', async () => {
		await expect(collect(streamOf('data: 1\n\ndata: 2\n\ndata: 3\n\n'))).resolves.toEqual([
			'1',
			'2',
			'3'
		]);
	});

	it('accepts CRLF framing', async () => {
		await expect(collect(streamOf('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'))).resolves.toEqual([
			'{"a":1}',
			'{"a":2}'
		]);
	});

	it('yields a final event that has no trailing blank line', async () => {
		await expect(collect(streamOf('data: {"a":1}'))).resolves.toEqual(['{"a":1}']);
	});

	it('joins multiple data lines within one event', async () => {
		await expect(collect(streamOf('data: line one\ndata: line two\n\n'))).resolves.toEqual([
			'line one\nline two'
		]);
	});

	it('ignores comments and other fields', async () => {
		await expect(
			collect(streamOf(': keep-alive\n\nevent: ping\nid: 7\n\ndata: real\n\n'))
		).resolves.toEqual(['real']);
	});

	it('tolerates a missing space after the colon', async () => {
		await expect(collect(streamOf('data:{"a":1}\n\n'))).resolves.toEqual(['{"a":1}']);
	});

	it('stops early when the signal aborts', async () => {
		const controller = new AbortController();
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(encoder.encode('data: 1\n\n'));
				// deliberately never closed
			},
			cancel() {}
		});

		const received: string[] = [];
		for await (const value of parseSseStream(stream, controller.signal)) {
			received.push(value);
			controller.abort();
		}
		expect(received).toEqual(['1']);
	});
});
