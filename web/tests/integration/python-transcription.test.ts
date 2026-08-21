import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PythonTranscriptionExecutor } from '../../src/lib/server/executors/python-transcription.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const AUDIO_PATH = join(REPO_ROOT, 'audio.wav');
const MODEL_ID = 'Systran/faster-whisper-tiny';
const MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--Systran--faster-whisper-tiny'
);
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_TRANSCRIPTION_INTEGRATION === '1' &&
	existsSync(PYTHON) &&
	existsSync(AUDIO_PATH) &&
	existsSync(MODEL_CACHE);
const TRANSCRIPTION_TIMEOUT_MS = Number(
	process.env.SPEACHY_TRANSCRIPTION_INTEGRATION_TIMEOUT_MS ?? 180_000
);

function readMonoPcm16Wav(path: string): { data: Float32Array; sampleRate: number } {
	const bytes = readFileSync(path);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('Integration fixture is not a RIFF/WAVE file');
	}

	let formatOffset: number | undefined;
	let dataOffset: number | undefined;
	let dataLength: number | undefined;
	for (let offset = 12; offset + 8 <= bytes.byteLength;) {
		const kind = bytes.toString('ascii', offset, offset + 4);
		const length = view.getUint32(offset + 4, true);
		if (kind === 'fmt ') formatOffset = offset + 8;
		if (kind === 'data') {
			dataOffset = offset + 8;
			dataLength = length;
			break;
		}
		offset += 8 + length + (length % 2);
	}
	if (formatOffset === undefined || dataOffset === undefined || dataLength === undefined) {
		throw new Error('Integration WAV is missing fmt or data');
	}
	if (view.getUint16(formatOffset, true) !== 1 || view.getUint16(formatOffset + 2, true) !== 1) {
		throw new Error('Integration WAV must be mono PCM');
	}
	if (view.getUint16(formatOffset + 14, true) !== 16) {
		throw new Error('Integration WAV must use 16-bit samples');
	}

	const sampleRate = view.getUint32(formatOffset + 4, true);
	const samples = new Float32Array(dataLength / 2);
	for (let index = 0; index < samples.length; index += 1) {
		samples[index] = view.getInt16(dataOffset + index * 2, true) / 32_768;
	}
	return { data: samples, sampleRate };
}

describe.runIf(RUN_INTEGRATION)('Python transcription integration', () => {
	it('transcribes the checked-in WAV through the TypeScript adapter and real cached model', async () => {
		const worker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			env: {
				...process.env,
				HF_HUB_OFFLINE: '1',
				WHISPER__INFERENCE_DEVICE: 'cpu',
				WHISPER__COMPUTE_TYPE: 'int8'
			},
			name: 'python-transcription-integration'
		});
		try {
			await worker.ping();
			const executor = new PythonTranscriptionExecutor(worker);
			const audio = readMonoPcm16Wav(AUDIO_PATH);
			const result = await executor.transcribe(
				{
					audio: { ...audio, name: 'audio' },
					model: MODEL_ID,
					responseFormat: 'json',
					temperature: 0,
					timestampGranularities: ['segment'],
					speechSegments: [{ start: 0, end: audio.data.length }],
					vadOptions: {
						threshold: 0.5,
						minSpeechDurationMs: 0,
						maxSpeechDurationS: 30,
						minSilenceDurationMs: 160,
						speechPadMs: 400
					},
					withoutTimestamps: true
				},
				AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)
			);
			expect(result.text.trim().length).toBeGreaterThan(0);
		} finally {
			await worker.close();
		}
	}, 190_000);
});
