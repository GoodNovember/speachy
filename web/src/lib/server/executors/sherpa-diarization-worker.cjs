/* eslint-disable @typescript-eslint/no-require-imports */
const { parentPort, workerData } = require('node:worker_threads');
const sherpaOnnx = require(workerData.modulePath);

if (parentPort === null) throw new Error('Sherpa diarization must run in a worker thread');

const inFlight = new Map();
let diarizer;

function getDiarizer() {
	diarizer ??= new sherpaOnnx.OfflineSpeakerDiarization({
		segmentation: {
			pyannote: {
				model: workerData.segmentation,
				windowShiftRatio: 0.1
			},
			numThreads: workerData.numThreads,
			provider: 'cpu',
			debug: 0
		},
		embedding: {
			model: workerData.embedding,
			numThreads: workerData.numThreads,
			provider: 'cpu',
			debug: 0
		},
		clustering: {
			numClusters: 0,
			threshold: 0.5
		},
		minDurationOn: 0.3,
		minDurationOff: 0.5
	});
	return diarizer;
}

function assertPayload(payload) {
	if (
		typeof payload !== 'object' ||
		payload === null ||
		!(payload.samples instanceof Float32Array) ||
		payload.sampleRate !== 16_000 ||
		!Number.isSafeInteger(payload.numSpeakers) ||
		payload.numSpeakers < 0
	) {
		throw new TypeError('Invalid native diarization payload');
	}
}

parentPort.on('message', (message) => {
	if (message.kind === 'cancel') {
		inFlight.get(message.id)?.abort(new Error('Cancelled by caller'));
		return;
	}

	const controller = new AbortController();
	inFlight.set(message.id, controller);
	try {
		if (message.method !== 'diarize') throw new Error(`Unknown method: ${message.method}`);
		assertPayload(message.payload);
		const loaded = getDiarizer();
		if (loaded.sampleRate !== message.payload.sampleRate) {
			throw new Error(
				`Sherpa diarization requires ${loaded.sampleRate} Hz audio, received ${message.payload.sampleRate} Hz`
			);
		}
		loaded.setConfig({
			clustering: {
				numClusters: message.payload.numSpeakers,
				threshold: 0.5
			}
		});
		if (controller.signal.aborted) throw controller.signal.reason;
		const value = loaded.process(message.payload.samples);
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
});
