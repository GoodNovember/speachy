import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeAudioUpload } from '../../src/lib/server/audio-decode.ts';
import { PythonDiarizationExecutor } from '../../src/lib/server/executors/python-diarization.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const AUDIO_PATH = join(REPO_ROOT, 'audio.wav');
const MODEL_ID = 'pyannote/speaker-diarization-community-1';
const MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--pyannote--speaker-diarization-community-1'
);
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_DIARIZATION_INTEGRATION === '1' &&
	existsSync(PYTHON) &&
	existsSync(AUDIO_PATH) &&
	existsSync(MODEL_CACHE);
const TIMEOUT_MS = Number(process.env.SPEACHY_DIARIZATION_INTEGRATION_TIMEOUT_MS ?? 300_000);

async function readAudioFixture(): Promise<Awaited<ReturnType<typeof decodeAudioUpload>>> {
	const source = readFileSync(AUDIO_PATH);
	const buffer = new ArrayBuffer(source.byteLength);
	new Uint8Array(buffer).set(source);
	const file = Object.assign(new Blob([buffer], { type: 'audio/wav' }), { name: 'audio.wav' });
	const audio = await decodeAudioUpload(file);
	const repetitions = Math.ceil((audio.sampleRate * 10) / audio.data.length);
	const data = new Float32Array(audio.data.length * repetitions);
	for (let index = 0; index < repetitions; index += 1) {
		data.set(audio.data, index * audio.data.length);
	}
	return { ...audio, data };
}

describe.runIf(RUN_INTEGRATION)('Python diarization integration', () => {
	it(
		'returns finite timestamped segments from the real cached Pyannote pipeline',
		async () => {
			const worker = new PythonWorkerClient({
				command: PYTHON,
				args: ['-m', 'speaches.inference_worker'],
				cwd: REPO_ROOT,
				env: { ...process.env, HF_HUB_OFFLINE: '1' },
				name: 'python-diarization-integration'
			});
			try {
				await worker.ping();
				const executor = new PythonDiarizationExecutor(worker);
				await expect(executor.canHandle(MODEL_ID)).resolves.toBe(true);
				const audio = await readAudioFixture();
				const segments = await executor.diarize(
					{ modelId: MODEL_ID, audio, numSpeakers: 1 },
					AbortSignal.timeout(TIMEOUT_MS)
				);

				expect(segments.length).toBeGreaterThan(0);
				for (const segment of segments) {
					expect(Number.isFinite(segment.start)).toBe(true);
					expect(Number.isFinite(segment.end)).toBe(true);
					expect(segment.start).toBeGreaterThanOrEqual(0);
					expect(segment.end).toBeGreaterThan(segment.start);
					expect(segment.speaker.length).toBeGreaterThan(0);
				}
			} finally {
				await worker.close();
			}
		},
		TIMEOUT_MS + 10_000
	);
});
