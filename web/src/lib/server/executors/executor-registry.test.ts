import { describe, expect, it } from 'vitest';
import { composeTranscriptionExecutors } from './executor-registry.ts';
import type { TranscriptionExecutor } from './types.ts';

function executor(name: string): TranscriptionExecutor {
	return {
		name,
		task: 'automatic-speech-recognition',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => false,
		transcribe: async () => ({ text: '' }),
		async *transcribeStream() {}
	};
}

describe('transcription executor composition', () => {
	const native = executor('native');
	const python = executor('python');

	it('keeps native ahead of the Python fallback in hybrid mode', () => {
		expect(composeTranscriptionExecutors('hybrid', native, python)).toEqual([native, python]);
	});

	it('makes native-only operation structurally unable to select Python', () => {
		expect(composeTranscriptionExecutors('native', native, python)).toEqual([native]);
	});

	it('retains an explicit Python baseline mode', () => {
		expect(composeTranscriptionExecutors('python', native, python)).toEqual([python]);
	});
});
