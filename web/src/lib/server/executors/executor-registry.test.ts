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
	const whisper = executor('whisper');
	const parakeet = executor('parakeet');
	const python = executor('python');

	it('keeps native ahead of the Python fallback in hybrid mode', () => {
		expect(composeTranscriptionExecutors('hybrid', [whisper, parakeet], python)).toEqual([
			whisper,
			parakeet,
			python
		]);
	});

	it('makes native-only operation structurally unable to select Python', () => {
		expect(composeTranscriptionExecutors('native', [whisper, parakeet], python)).toEqual([
			whisper,
			parakeet
		]);
	});

	it('retains an explicit Python baseline mode', () => {
		expect(composeTranscriptionExecutors('python', [whisper, parakeet], python)).toEqual([python]);
	});
});
