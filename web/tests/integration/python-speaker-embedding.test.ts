import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PythonSpeakerEmbeddingExecutor } from '../../src/lib/server/executors/python-speaker-embedding.ts';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const MODEL_ID = 'pyannote/wespeaker-voxceleb-resnet34-LM';
const MODEL_CACHE = join(
	homedir(),
	'.cache',
	'huggingface',
	'hub',
	'models--pyannote--wespeaker-voxceleb-resnet34-LM'
);
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_EMBEDDING_INTEGRATION === '1' &&
	existsSync(PYTHON) &&
	existsSync(MODEL_CACHE);

describe.runIf(RUN_INTEGRATION)('Python speaker embedding integration', () => {
	it('returns a finite vector from the real cached WeSpeaker model', async () => {
		const worker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			env: { ...process.env, HF_HUB_OFFLINE: '1' },
			name: 'python-speaker-embedding-integration'
		});
		try {
			await worker.ping();
			const executor = new PythonSpeakerEmbeddingExecutor(worker);
			const audio = new Float32Array(16_000);
			for (let index = 0; index < audio.length; index += 1) {
				audio[index] = Math.sin((2 * Math.PI * 220 * index) / 16_000) * 0.1;
			}
			const embedding = await executor.embed(
				{ modelId: MODEL_ID, audio: { data: audio, sampleRate: 16_000 } },
				AbortSignal.timeout(180_000)
			);
			expect(embedding.length).toBeGreaterThan(0);
			expect(embedding.every(Number.isFinite)).toBe(true);
		} finally {
			await worker.close();
		}
	}, 190_000);
});
