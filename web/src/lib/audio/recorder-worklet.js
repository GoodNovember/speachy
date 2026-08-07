// Runs on the audio thread. Kept dependency-free and in plain JS because an
// AudioWorklet module is loaded by URL and cannot pull in the app's bundle.
//
// process() is called with 128 frames at a time, which would be ~125 messages
// per second. Buffer up to a requested frame size before posting so the main
// thread wakes far less often.

class PcmRecorderProcessor extends AudioWorkletProcessor {
	/** @param {{ processorOptions?: { frameSize?: number } }} [options] */
	constructor(options) {
		super();
		const frameSize = options?.processorOptions?.frameSize;
		this.frameSize = typeof frameSize === 'number' && frameSize > 0 ? frameSize : 2048;
		this.buffer = new Float32Array(this.frameSize);
		this.offset = 0;
		this.stopped = false;
		this.port.onmessage = (event) => {
			if (event.data === 'stop') this.stopped = true;
		};
	}

	/**
	 * @param {Float32Array[][]} inputs
	 * @returns {boolean}
	 */
	process(inputs) {
		if (this.stopped) return false;

		const channel = inputs[0]?.[0];
		if (channel === undefined) return true;

		for (let i = 0; i < channel.length; i += 1) {
			this.buffer[this.offset] = channel[i];
			this.offset += 1;
			if (this.offset === this.frameSize) {
				// Transfer a copy; the underlying input buffer is reused each call.
				this.port.postMessage(this.buffer.slice(0));
				this.offset = 0;
			}
		}
		return true;
	}
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
