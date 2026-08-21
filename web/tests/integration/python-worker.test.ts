import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PythonWorkerClient } from '../../src/lib/server/executors/python-worker.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PYTHON = join(
	REPO_ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const RUN_INTEGRATION = process.env.SPEACHY_RUN_WORKER_INTEGRATION === '1' && existsSync(PYTHON);

describe.runIf(RUN_INTEGRATION)('Python inference worker integration', () => {
	it('starts the real Python module and completes the protocol handshake', async () => {
		const worker = new PythonWorkerClient({
			command: PYTHON,
			args: ['-m', 'speaches.inference_worker'],
			cwd: REPO_ROOT,
			name: 'python-inference-integration'
		});
		try {
			const ping = await worker.ping();
			expect(ping.protocol_version).toBe(1);
			// Windows venv launchers may hand off to a different interpreter PID.
			expect(ping.pid).toBeGreaterThan(0);
			await expect(worker.listLoaded({ signal: AbortSignal.timeout(30_000) })).resolves.toEqual({
				models: []
			});
		} finally {
			await worker.close();
		}
	}, 60_000);
});
