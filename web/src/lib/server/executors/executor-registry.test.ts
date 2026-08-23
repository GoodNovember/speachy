import { describe, expect, it } from 'vitest';
import { composeDiarizationExecutors, composeTranscriptionExecutors } from './executor-registry.ts';
import type { DiarizationExecutor, TranscriptionExecutor } from './types.ts';

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

function diarizationExecutor(name: string): DiarizationExecutor {
	return {
		name,
		task: 'speaker-diarization',
		listLocalModels: async () => [],
		listRemoteModels: async () => [],
		canHandle: async () => false,
		diarize: async () => []
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

describe('diarization executor composition', () => {
	const native = diarizationExecutor('sherpa');
	const python = diarizationExecutor('python');

	it('prefers native in hybrid mode while retaining the Python reference', () => {
		expect(composeDiarizationExecutors('hybrid', native, python)).toEqual([native, python]);
	});

	it('keeps native-only and Python-only selection explicit', () => {
		expect(composeDiarizationExecutors('native', native, python)).toEqual([native]);
		expect(composeDiarizationExecutors('python', native, python)).toEqual([python]);
	});
});
