import { describe, expect, it } from 'vitest';
import {
	EOFTextChunker,
	formatAsSrt,
	formatAsSse,
	formatAsVtt,
	SentenceChunker,
	srtFormatTimestamp,
	stripEmojis,
	stripMarkdownEmphasis,
	vttFormatTimestamp
} from './text-utils.ts';

describe.each([
	['srt', srtFormatTimestamp, ','],
	['vtt', vttFormatTimestamp, '.']
] as const)('%s timestamps', (_name, format, separator) => {
	it.each([
		[0, '00:00:00'],
		[1, '00:00:01'],
		[1.234, '00:00:01'],
		[60, '00:01:00'],
		[61.234, '00:01:01'],
		[3601.234, '01:00:01'],
		[23423.4234, '06:30:23']
	])('formats %s seconds', (timestamp, whole) => {
		const milliseconds = Math.trunc((timestamp * 1000) % 1000)
			.toString()
			.padStart(3, '0');
		expect(format(timestamp)).toBe(`${whole}${separator}${milliseconds}`);
	});
});

it('formats SSE, SRT, and VTT frames like the Python implementation', () => {
	expect(formatAsSse('{"text":"hello"}')).toBe('data: {"text":"hello"}\n\n');
	expect(formatAsSrt('Hello', 1.25, 2.5, 1)).toBe('2\n00:00:01,250 --> 00:00:02,500\nHello\n\n');
	expect(formatAsVtt('First', 1.25, 2.5, 0)).toBe(
		'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nFirst\n\n'
	);
	expect(formatAsVtt('Second', 2.5, 3.75, 1)).toBe('00:00:02.500 --> 00:00:03.750\nSecond\n\n');
});

describe('text cleanup', () => {
	it.each([
		['Hello my name is **Jon**', 'Hello my name is Jon'],
		['I *really* like this', 'I really like this'],
		['This is __underlined__', 'This is underlined'],
		['This is _italic_', 'This is italic'],
		['Nested **bold *with italic* inside**', 'Nested bold with italic inside']
	])('strips markdown emphasis from %s', (input, expected) => {
		expect(stripMarkdownEmphasis(input)).toBe(expected);
	});

	it('strips the same emoji ranges as Python', () => {
		expect(stripEmojis('Hello 👋 world ✈!')).toBe('Hello  world !');
	});
});

async function collect(chunker: AsyncIterable<string>): Promise<string[]> {
	const chunks: string[] = [];
	for await (const chunk of chunker) chunks.push(chunk);
	return chunks;
}

describe('SentenceChunker', () => {
	it('streams complete sentences across token boundaries', async () => {
		const chunker = new SentenceChunker(10);
		const chunks = collect(chunker);
		chunker.addToken('A short. This sentence');
		chunker.addToken(' is long enough! Tail');
		chunker.close();
		expect(await chunks).toEqual(['A short. This sentence is long enough!', ' Tail']);
	});

	it('combines short sentences until the minimum length is met', async () => {
		const chunker = new SentenceChunker(12);
		const chunks = collect(chunker);
		chunker.addToken('Hi! Bye! Enough now.');
		chunker.close();
		expect(await chunks).toEqual(['Hi! Bye! Enough now.']);
	});

	it('rejects tokens after close', () => {
		const chunker = new SentenceChunker();
		chunker.close();
		expect(() => chunker.addToken('late')).toThrow('Cannot add tokens to a closed SentenceChunker');
	});
});

describe('EOFTextChunker', () => {
	it('emits accumulated text once, only after close', async () => {
		const chunker = new EOFTextChunker();
		const chunks = collect(chunker);
		chunker.addToken('Hello ');
		chunker.addToken('world!');
		chunker.close();
		expect(await chunks).toEqual(['Hello world!']);
	});

	it('emits nothing when closed empty', async () => {
		const chunker = new EOFTextChunker();
		const chunks = collect(chunker);
		chunker.close();
		expect(await chunks).toEqual([]);
	});

	it('rejects tokens after close', () => {
		const chunker = new EOFTextChunker();
		chunker.close();
		expect(() => chunker.addToken('late')).toThrow('Cannot add tokens to a closed EOFTextChunker');
	});
});
