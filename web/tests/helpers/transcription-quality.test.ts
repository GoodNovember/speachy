import { describe, expect, it } from 'vitest';
import { normalizeTranscript, scoreTranscript } from './transcription-quality.ts';

describe('transcription quality scoring', () => {
	it('normalizes presentation without hiding lexical or numeric differences', () => {
		expect(normalizeTranscript('HARKER’S café -- 8:35 P.M.')).toEqual([
			'harkers',
			'cafe',
			'8',
			'35',
			'p',
			'm'
		]);
		expect(normalizeTranscript('eight thirty-five')).toEqual(['eight', 'thirty', 'five']);
	});

	it('reports substitutions, deletions, and insertions separately', () => {
		expect(scoreTranscript('the quick fox', 'the slow fox')).toMatchObject({
			substitutions: 1,
			deletions: 0,
			insertions: 0
		});
		expect(scoreTranscript('the quick brown fox', 'the quick fox')).toMatchObject({
			substitutions: 0,
			deletions: 1,
			insertions: 0
		});
		expect(scoreTranscript('the quick fox', 'the very quick fox')).toMatchObject({
			substitutions: 0,
			deletions: 0,
			insertions: 1
		});
	});

	it('handles empty reference and hypothesis text explicitly', () => {
		expect(scoreTranscript('', '')).toMatchObject({ errorCount: 0, wordErrorRate: 0 });
		expect(scoreTranscript('', 'unexpected words')).toMatchObject({
			insertions: 2,
			errorCount: 2,
			wordErrorRate: Number.POSITIVE_INFINITY
		});
		expect(scoreTranscript('missing words', '')).toMatchObject({
			deletions: 2,
			errorCount: 2,
			wordErrorRate: 1
		});
	});
});
