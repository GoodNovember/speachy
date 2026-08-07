// The worklet is small enough that Vite inlines it as a data: URI rather than
// emitting a file, so addModule() has nothing to fetch and cannot 404. If it
// ever grows past the inline limit it becomes a real asset request instead,
// which still works but is worth knowing when debugging.
import workletUrl from './recorder-worklet.js?url';
import { concatFloat32, floatToPcm16, REALTIME_SAMPLE_RATE, resampleLinear, rms } from './pcm.ts';

export type MicRecorderOptions = {
	targetSampleRate?: number;
	frameSize?: number;
	// Called with each resampled PCM16 frame, ready to send over the socket.
	onFrame?: (frame: Int16Array) => void;
	onLevel?: (level: number) => void;
};

export type MicRecorderInfo = {
	contextSampleRate: number;
	targetSampleRate: number;
	// True when the browser would not open the context at the target rate and
	// we are resampling in JS instead.
	resamplingInJs: boolean;
};

export class MicRecorder {
	#targetSampleRate: number;
	#frameSize: number;
	#onFrame: ((frame: Int16Array) => void) | undefined;
	#onLevel: ((level: number) => void) | undefined;

	#context: AudioContext | undefined;
	#stream: MediaStream | undefined;
	#source: MediaStreamAudioSourceNode | undefined;
	#node: AudioWorkletNode | undefined;
	#captured: Float32Array[] = [];
	#recording = false;

	constructor(options: MicRecorderOptions = {}) {
		this.#targetSampleRate = options.targetSampleRate ?? REALTIME_SAMPLE_RATE;
		this.#frameSize = options.frameSize ?? 2048;
		this.#onFrame = options.onFrame;
		this.#onLevel = options.onLevel;
	}

	get isRecording(): boolean {
		return this.#recording;
	}

	get info(): MicRecorderInfo | undefined {
		if (this.#context === undefined) return undefined;
		return {
			contextSampleRate: this.#context.sampleRate,
			targetSampleRate: this.#targetSampleRate,
			resamplingInJs: this.#context.sampleRate !== this.#targetSampleRate
		};
	}

	async start(): Promise<MicRecorderInfo> {
		if (this.#recording) throw new Error('Already recording');

		this.#stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});

		// Ask for the target rate directly. When the browser honours it the
		// resampling happens natively and sounds better than anything we would
		// do in JS; resampleLinear below is only the fallback.
		this.#context = new AudioContext({ sampleRate: this.#targetSampleRate });
		if (this.#context.state === 'suspended') await this.#context.resume();

		await this.#context.audioWorklet.addModule(workletUrl);

		this.#source = this.#context.createMediaStreamSource(this.#stream);
		this.#node = new AudioWorkletNode(this.#context, 'pcm-recorder', {
			numberOfInputs: 1,
			numberOfOutputs: 0,
			processorOptions: { frameSize: this.#frameSize }
		});

		const contextRate = this.#context.sampleRate;
		this.#node.port.onmessage = (event: MessageEvent<Float32Array>) => {
			const frame = event.data;
			this.#captured.push(frame);
			this.#onLevel?.(rms(frame));
			if (this.#onFrame !== undefined) {
				const resampled = resampleLinear(frame, contextRate, this.#targetSampleRate);
				this.#onFrame(floatToPcm16(resampled));
			}
		};

		this.#source.connect(this.#node);
		this.#recording = true;
		return this.info!;
	}

	// Returns everything captured, resampled to the target rate.
	async stop(): Promise<{ pcm: Int16Array; sampleRate: number; durationSeconds: number }> {
		const contextRate = this.#context?.sampleRate ?? this.#targetSampleRate;

		this.#node?.port.postMessage('stop');
		this.#node?.disconnect();
		this.#source?.disconnect();
		for (const track of this.#stream?.getTracks() ?? []) track.stop();
		await this.#context?.close();

		this.#node = undefined;
		this.#source = undefined;
		this.#stream = undefined;
		this.#context = undefined;
		this.#recording = false;

		const merged = concatFloat32(this.#captured);
		this.#captured = [];
		const resampled = resampleLinear(merged, contextRate, this.#targetSampleRate);

		return {
			pcm: floatToPcm16(resampled),
			sampleRate: this.#targetSampleRate,
			durationSeconds: resampled.length / this.#targetSampleRate
		};
	}
}
