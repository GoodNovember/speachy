import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PythonSpeechExecutor } from '../../src/lib/server/executors/python-speech.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const MODEL_ID = 'speaches-ai/Kokoro-82M-v1.0-ONNX';
const MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--speaches-ai--Kokoro-82M-v1.0-ONNX'
);
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_SPEECH_INTEGRATION === '1' &&
	existsSync(PYTHON) &&
	existsSync(MODEL_CACHE);

describe.runIf(RUN_INTEGRATION)('Python speech integration', () => {
	it('streams finite Float32 audio from the real cached Kokoro model', async () => {
		const worker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			env: { ...process.env, HF_HUB_OFFLINE: '1' },
			name: 'python-speech-integration'
		});
		try {
			await worker.ping();
			const executor = new PythonSpeechExecutor(worker);
			await expect(executor.canHandle(MODEL_ID)).resolves.toBe(true);
			await expect(executor.listVoices(MODEL_ID)).resolves.toContain('af_heart');

			const chunks = [];
			for await (const chunk of executor.synthesize(
				{ model: MODEL_ID, voice: 'af_heart', text: 'Hello from Speachy.', speed: 1 },
				AbortSignal.timeout(180_000)
			)) {
				chunks.push(chunk);
			}
			expect(chunks.length).toBeGreaterThan(0);
			expect(chunks.every((chunk) => chunk.sampleRate === 24_000)).toBe(true);
			expect(chunks.reduce((total, chunk) => total + chunk.data.length, 0)).toBeGreaterThan(0);
			expect(chunks.every((chunk) => chunk.data.every(Number.isFinite))).toBe(true);
		} finally {
			await worker.close();
		}
	}, 190_000);
});
