import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTranscriptionResponse } from '../../src/lib/server/transcription-http.ts';
import { SHERPA_WHISPER_MODEL_ID } from '../../src/lib/server/native-whisper.ts';
import { SherpaWhisperTranscriptionExecutor } from '../../src/lib/server/executors/sherpa-transcription.ts';

const AUDIO_PATH = fileURLToPath(new URL('../../../audio.wav', import.meta.url));
const RUN_INTEGRATION =
	process.env.SPEACHY_RUN_NATIVE_TRANSCRIPTION_INTEGRATION === '1' && existsSync(AUDIO_PATH);

describe.runIf(RUN_INTEGRATION)('native transcription integration', () => {
	it('serves a real transcription through the HTTP boundary without Python', async () => {
		const bytes = await readFile(AUDIO_PATH);
		const body = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(body).set(bytes);
		const form = new FormData();
		form.set('file', new Blob([body], { type: 'audio/wav' }), 'audio.wav');
		form.set('model', SHERPA_WHISPER_MODEL_ID);
		const executor = new SherpaWhisperTranscriptionExecutor();
		try {
			const response = await createTranscriptionResponse(form, AbortSignal.timeout(30_000), [
				executor
			]);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ text: 'Hello World.' });
		} finally {
			await executor.close();
		}
	}, 35_000);
});
