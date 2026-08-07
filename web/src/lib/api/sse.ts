// The reference sends `data: {json}\n\n` and never terminates with the
// `data: [DONE]` sentinel that OpenAI uses, so end-of-stream is end-of-body.
// A parser that waits for [DONE] hangs here. We still tolerate the sentinel so
// this keeps working if our own server chooses to emit it.

export const DONE_SENTINEL = '[DONE]';

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	const onAbort = (): void => void reader.cancel().catch(() => {});
	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// Events are separated by a blank line. Tolerate CRLF.
			let separator = findSeparator(buffer);
			while (separator !== null) {
				const rawEvent = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator.length);
				const data = dataOf(rawEvent);
				if (data !== null) {
					if (data === DONE_SENTINEL) return;
					yield data;
				}
				separator = findSeparator(buffer);
			}
		}

		// A final event with no trailing blank line still counts.
		const trailing = dataOf(buffer);
		if (trailing !== null && trailing !== DONE_SENTINEL) yield trailing;
	} finally {
		signal?.removeEventListener('abort', onAbort);
		reader.releaseLock();
	}
}

function findSeparator(buffer: string): { index: number; length: number } | null {
	const lf = buffer.indexOf('\n\n');
	const crlf = buffer.indexOf('\r\n\r\n');
	if (lf === -1 && crlf === -1) return null;
	if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
	return { index: lf, length: 2 };
}

// An event may carry several data: lines, which concatenate with newlines.
function dataOf(rawEvent: string): string | null {
	const parts: string[] = [];
	for (const line of rawEvent.split(/\r?\n/)) {
		if (!line.startsWith('data:')) continue;
		parts.push(line.slice(5).replace(/^ /, ''));
	}
	if (parts.length === 0) return null;
	const joined = parts.join('\n');
	return joined.trim() === '' ? null : joined;
}

export async function* parseSseJson<T>(
	body: ReadableStream<Uint8Array>,
	parse: (value: unknown) => T,
	signal?: AbortSignal
): AsyncGenerator<T> {
	for await (const data of parseSseStream(body, signal)) {
		yield parse(JSON.parse(data));
	}
}
