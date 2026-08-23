export type TranscriptQuality = {
	referenceWordCount: number;
	hypothesisWordCount: number;
	substitutions: number;
	deletions: number;
	insertions: number;
	errorCount: number;
	wordErrorRate: number;
};

/**
 * Light WER normalization: Unicode compatibility folding, case folding,
 * apostrophe joining, and punctuation-to-space. Lexical and numeric-format
 * differences intentionally remain visible in the score.
 */
export function normalizeTranscript(text: string): string[] {
	const normalized = text
		.normalize('NFKD')
		.toLocaleLowerCase('en-US')
		.replace(/\p{M}/gu, '')
		.replace(/[’']/gu, '')
		.replace(/&/gu, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
	return normalized === '' ? [] : normalized.split(/\s+/u);
}

export function scoreTranscript(reference: string, hypothesis: string): TranscriptQuality {
	const referenceWords = normalizeTranscript(reference);
	const hypothesisWords = normalizeTranscript(hypothesis);
	const columns = hypothesisWords.length + 1;
	let previous = new Uint32Array(columns);
	let current = new Uint32Array(columns);
	const operations = new Uint8Array((referenceWords.length + 1) * columns);
	for (let column = 1; column < columns; column += 1) {
		previous[column] = column;
		operations[column] = 3;
	}

	for (let row = 1; row <= referenceWords.length; row += 1) {
		current[0] = row;
		operations[row * columns] = 2;
		for (let column = 1; column < columns; column += 1) {
			const operationIndex = row * columns + column;
			if (referenceWords[row - 1] === hypothesisWords[column - 1]) {
				current[column] = previous[column - 1]!;
				operations[operationIndex] = 0;
				continue;
			}
			const substitution = previous[column - 1]! + 1;
			const deletion = previous[column]! + 1;
			const insertion = current[column - 1]! + 1;
			// Tie order is deterministic: substitution, deletion, insertion.
			if (substitution <= deletion && substitution <= insertion) {
				current[column] = substitution;
				operations[operationIndex] = 1;
			} else if (deletion <= insertion) {
				current[column] = deletion;
				operations[operationIndex] = 2;
			} else {
				current[column] = insertion;
				operations[operationIndex] = 3;
			}
		}
		[previous, current] = [current, previous];
	}

	let substitutions = 0;
	let deletions = 0;
	let insertions = 0;
	let row = referenceWords.length;
	let column = hypothesisWords.length;
	while (row > 0 || column > 0) {
		const operation = operations[row * columns + column];
		if (operation === 0) {
			row -= 1;
			column -= 1;
		} else if (operation === 1) {
			substitutions += 1;
			row -= 1;
			column -= 1;
		} else if (operation === 2) {
			deletions += 1;
			row -= 1;
		} else {
			insertions += 1;
			column -= 1;
		}
	}
	const errorCount = substitutions + deletions + insertions;
	return {
		referenceWordCount: referenceWords.length,
		hypothesisWordCount: hypothesisWords.length,
		substitutions,
		deletions,
		insertions,
		errorCount,
		wordErrorRate:
			referenceWords.length === 0
				? hypothesisWords.length === 0
					? 0
					: Number.POSITIVE_INFINITY
				: errorCount / referenceWords.length
	};
}
