export interface TextChunker extends AsyncIterable<string> {
	addToken(token: string): void;
	close(): void;
}

export function formatAsSse(data: string): string {
	return `data: ${data}\n\n`;
}

function formatTimestamp(timestamp: number, millisecondSeparator: ',' | '.'): string {
	const hours = Math.trunc(timestamp / 3600);
	const minutes = Math.trunc((timestamp % 3600) / 60);
	const seconds = Math.trunc(timestamp % 60);
	const milliseconds = Math.trunc((timestamp * 1000) % 1000);
	return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}${millisecondSeparator}${milliseconds.toString().padStart(3, '0')}`;
}

export function srtFormatTimestamp(timestamp: number): string {
	return formatTimestamp(timestamp, ',');
}

export function vttFormatTimestamp(timestamp: number): string {
	return formatTimestamp(timestamp, '.');
}

export function formatAsVtt(text: string, start: number, end: number, index: number): string {
	const cueStart = index > 0 ? start : 0;
	const cue = `${vttFormatTimestamp(cueStart)} --> ${vttFormatTimestamp(end)}\n${text}\n\n`;
	return index === 0 ? `WEBVTT\n\n${cue}` : cue;
}

export function formatAsSrt(text: string, start: number, end: number, index: number): string {
	return `${index + 1}\n${srtFormatTimestamp(start)} --> ${srtFormatTimestamp(end)}\n${text}\n\n`;
}

export const MIN_SENTENCE_LENGTH = 20;

abstract class AsyncTextChunker implements TextChunker {
	protected content = '';
	protected isClosed = false;
	private wake: (() => void) | undefined;

	addToken(token: string): void {
		if (this.isClosed) throw new Error(`Cannot add tokens to a closed ${this.constructor.name}`);
		this.content += token;
		this.notify();
	}

	close(): void {
		this.isClosed = true;
		this.notify();
	}

	protected waitForChange(): Promise<void> {
		return new Promise((resolve) => {
			this.wake = resolve;
		});
	}

	private notify(): void {
		this.wake?.();
		this.wake = undefined;
	}

	abstract [Symbol.asyncIterator](): AsyncGenerator<string>;
}

export class SentenceChunker extends AsyncTextChunker {
	private processedIndex = 0;
	private accumulatedText = '';

	constructor(private readonly minSentenceLength = MIN_SENTENCE_LENGTH) {
		super();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<string> {
		while (true) {
			const endingIndexes = ['.', '!', '?']
				.map((ending) => this.content.indexOf(ending, this.processedIndex))
				.filter((index) => index !== -1);
			const nextEnd = endingIndexes.length > 0 ? Math.min(...endingIndexes) : -1;

			if (nextEnd !== -1) {
				const sentenceEnd = nextEnd + 1;
				const sentence = this.content.slice(this.processedIndex, sentenceEnd);
				this.processedIndex = sentenceEnd;
				const combinedText = this.accumulatedText + sentence;

				if (combinedText.trim().length >= this.minSentenceLength) {
					this.accumulatedText = '';
					yield combinedText;
				} else {
					this.accumulatedText = combinedText;
				}
				continue;
			}

			if (this.isClosed) {
				const remaining = this.content.slice(this.processedIndex);
				const finalText = this.accumulatedText + remaining;
				if (finalText.trim()) yield finalText;
				return;
			}

			await this.waitForChange();
		}
	}
}

const EMOJI_PATTERN =
	/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}]+/gu;

export function stripEmojis(text: string): string {
	return text.replace(EMOJI_PATTERN, '');
}

export function stripMarkdownEmphasis(text: string): string {
	return text
		.replace(/\*\*(.*?)\*\*/g, '$1')
		.replace(/\*(.*?)\*/g, '$1')
		.replace(/__(.*?)__/g, '$1')
		.replace(/_(.*?)_/g, '$1');
}

export class EOFTextChunker extends AsyncTextChunker {
	async *[Symbol.asyncIterator](): AsyncGenerator<string> {
		while (!this.isClosed) await this.waitForChange();
		if (this.content) yield this.content;
	}
}
