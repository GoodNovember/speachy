const { parentPort, workerData } = require('node:worker_threads');
const { join } = require('node:path');
const sherpaOnnx = require(workerData.modulePath);

if (parentPort === null) throw new Error('Sherpa transcription must run in a worker thread');

const directory = workerData.modelDirectory;
const numThreads = workerData.numThreads;
const inFlight = new Map();
let recognizer;

function getRecognizer() {
	recognizer ??= sherpaOnnx.OfflineRecognizer.createAsync({
		featConfig: { sampleRate: 16_000, featureDim: 80 },
		modelConfig: {
			whisper: {
				encoder: join(directory, 'tiny.en-encoder.int8.onnx'),
				decoder: join(directory, 'tiny.en-decoder.int8.onnx'),
				language: 'en',
				task: 'transcribe'
			},
			tokens: join(directory, 'tiny.en-tokens.txt'),
			numThreads,
			provider: 'cpu',
			debug: 0
		}
	});
	return recognizer;
}

function assertPayload(payload) {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!(payload.samples instanceof Float32Array) ||
		!Number.isSafeInteger(payload.sampleRate) ||
		payload.sampleRate <= 0
	) {
		throw new TypeError('Invalid native transcription payload');
	}
}

parentPort.on('message', (message) => {
	if (message.kind === 'cancel') {
		inFlight.get(message.id)?.abort(new Error('Cancelled by caller'));
		return;
	}

	const controller = new AbortController();
	inFlight.set(message.id, controller);
	void (async () => {
		try {
			if (message.method !== 'transcribe') throw new Error(`Unknown method: ${message.method}`);
			assertPayload(message.payload);
			const loaded = await getRecognizer();
			if (controller.signal.aborted) throw controller.signal.reason;
			const stream = loaded.createStream();
			stream.acceptWaveform({
				sampleRate: message.payload.sampleRate,
				samples: message.payload.samples
			});
			const value = await loaded.decodeAsync(stream);
			if (controller.signal.aborted) throw controller.signal.reason;
			parentPort.postMessage({ id: message.id, kind: 'ok', value });
		} catch (error) {
			parentPort.postMessage({
				id: message.id,
				kind: 'error',
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined
			});
		} finally {
			inFlight.delete(message.id);
		}
	})();
});
