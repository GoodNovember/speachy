// recorder-worklet.js runs in AudioWorkletGlobalScope, a separate realm whose
// globals are not in the DOM lib. Declared here so the file stays type-checked
// rather than being excluded from the project.

declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: { processorOptions?: Record<string, unknown> });
	process(
		inputs: Float32Array[][],
		outputs: Float32Array[][],
		parameters: Record<string, Float32Array>
	): boolean;
}

declare function registerProcessor(
	name: string,
	processorCtor: new (options?: {
		processorOptions?: Record<string, unknown>;
	}) => AudioWorkletProcessor
): void;
