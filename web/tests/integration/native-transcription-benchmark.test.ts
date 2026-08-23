import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../../src/lib/server/audio-decode.ts';
import { SHERPA_PARAKEET_MODEL_ID } from '../../src/lib/server/native-parakeet.ts';
import { SHERPA_WHISPER_MODEL_ID } from '../../src/lib/server/native-whisper.ts';
import { PythonTranscriptionExecutor } from '../../src/lib/server/executors/python-transcription.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';
import { SherpaParakeetTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-parakeet-transcription.ts';
import { SherpaWhisperTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-transcription.ts';
import type {
	TranscriptionExecutor,
	TranscriptionRequest
} from '../../src/lib/server/executors/types.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const AUDIO_PATH = join(REPO_ROOT, 'audio.wav');
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const PYTHON_MODEL_ID = 'Systran/faster-whisper-tiny';
const PYTHON_MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--Systran--faster-whisper-tiny'
);
const RUN_BENCHMARK =
	process.env.SPEACHY_RUN_NATIVE_TRANSCRIPTION_BENCHMARK === '1' &&
	existsSync(AUDIO_PATH) &&
	existsSync(PYTHON) &&
	existsSync(PYTHON_MODEL_CACHE);

async function audio() {
	const bytes = await readFile(AUDIO_PATH);
	const body = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(body).set(bytes);
	return decodeAudioUpload(new Blob([body], { type: 'audio/wav' }), {
		signal: AbortSignal.timeout(10_000)
	});
}

function request(model: string, decoded: Awaited<ReturnType<typeof audio>>): TranscriptionRequest {
	return {
		audio: decoded,
		model,
		responseFormat: 'json',
		temperature: 0,
		timestampGranularities: ['segment'],
		speechSegments: [{ start: 0, end: decoded.data.length }],
		vadOptions: {
			threshold: 0.5,
			minSpeechDurationMs: 0,
			maxSpeechDurationS: 30,
			minSilenceDurationMs: 160,
			speechPadMs: 400
		},
		withoutTimestamps: true
	};
}

async function measure(executor: TranscriptionExecutor, input: TranscriptionRequest) {
	const started = performance.now();
	const result = await executor.transcribe(input, AbortSignal.timeout(180_000));
	return { elapsedMs: performance.now() - started, text: result.text };
}

describe.runIf(RUN_BENCHMARK)('native transcription benchmark', () => {
	it('records cold and warm evidence against the Python baseline', async () => {
		const decoded = await audio();
		const durationSeconds = decoded.data.length / decoded.sampleRate;
		const pythonWorker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HF_HUB_OFFLINE: '1',
				WHISPER__INFERENCE_DEVICE: 'cpu',
				WHISPER__COMPUTE_TYPE: 'int8'
			},
			name: 'native-transcription-benchmark-python'
		});
		const python = new PythonTranscriptionExecutor(pythonWorker);
		const whisper = new SherpaWhisperTranscriptionExecutor();
		const parakeet = new SherpaParakeetTranscriptionExecutor();
		try {
			await pythonWorker.ping();
			const evidence = {
				durationSeconds,
				python: {
					cold: await measure(python, request(PYTHON_MODEL_ID, decoded)),
					warm: await measure(python, request(PYTHON_MODEL_ID, decoded))
				},
				whisper: {
					cold: await measure(whisper, request(SHERPA_WHISPER_MODEL_ID, decoded)),
					warm: await measure(whisper, request(SHERPA_WHISPER_MODEL_ID, decoded))
				},
				parakeet: {
					cold: await measure(parakeet, request(SHERPA_PARAKEET_MODEL_ID, decoded)),
					warm: await measure(parakeet, request(SHERPA_PARAKEET_MODEL_ID, decoded))
				}
			};
			console.info('SPEACHY_NATIVE_TRANSCRIPTION_BENCHMARK', JSON.stringify(evidence));
			expect(evidence.python.warm.text.trim()).not.toBe('');
			expect(evidence.whisper.warm.text.trim()).not.toBe('');
			expect(evidence.parakeet.warm.text.trim()).not.toBe('');
		} finally {
			await Promise.all([pythonWorker.close(), whisper.close(), parakeet.close()]);
		}
	}, 190_000);
});
