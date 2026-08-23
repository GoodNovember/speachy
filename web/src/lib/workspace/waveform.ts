export const DEFAULT_WAVEFORM_PIXELS_PER_SECOND = 96;
export const MIN_WAVEFORM_WIDTH = 720;
export const MAX_WAVEFORM_RASTER_WIDTH = 32_760;

export function waveformRenderWidth(
	duration: number,
	pixelsPerSecond = DEFAULT_WAVEFORM_PIXELS_PER_SECOND,
	minimumWidth = MIN_WAVEFORM_WIDTH
): number {
	if (!Number.isFinite(duration) || duration < 0) throw new RangeError('Invalid audio duration');
	if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
		throw new RangeError('Invalid waveform pixel density');
	}
	if (!Number.isInteger(minimumWidth) || minimumWidth <= 0) {
		throw new RangeError('Invalid minimum waveform width');
	}
	const width = Math.max(minimumWidth, Math.ceil(duration * pixelsPerSecond));
	if (!Number.isSafeInteger(width)) throw new RangeError('Waveform width exceeds browser limits');
	return width;
}

export function waveformRasterWidth(
	renderWidth: number,
	maximumWidth = MAX_WAVEFORM_RASTER_WIDTH
): number {
	if (!Number.isInteger(renderWidth) || renderWidth <= 0) {
		throw new RangeError('Invalid waveform render width');
	}
	if (!Number.isInteger(maximumWidth) || maximumWidth <= 0) {
		throw new RangeError('Invalid maximum waveform raster width');
	}
	return Math.min(renderWidth, maximumWidth);
}

export function waveformXForTime(time: number, duration: number, width: number): number {
	if (!(duration > 0) || !(width > 0)) return 0;
	return (Math.min(duration, Math.max(0, time)) / duration) * width;
}

export function waveformTimeForX(x: number, duration: number, width: number): number {
	if (!(duration > 0) || !(width > 0)) return 0;
	return (Math.min(width, Math.max(0, x)) / width) * duration;
}

export function formatWaveformTime(seconds: number): string {
	const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
	const minutes = Math.floor(safeSeconds / 60);
	const remainder = safeSeconds - minutes * 60;
	return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
}

function mixedSample(channels: readonly Float32Array[], frame: number): number {
	let sum = 0;
	for (const channel of channels) sum += channel[frame] ?? 0;
	return sum / channels.length;
}

// Interleaved [minimum, maximum] pairs, one pair per rendered CSS pixel.
// Each source frame is visited once per channel when width <= frame count.
export function calculateWaveformPeaks(
	channels: readonly Float32Array[],
	width: number
): Float32Array {
	if (!Number.isInteger(width) || width <= 0) throw new RangeError('Invalid waveform width');
	if (channels.length === 0) return new Float32Array(width * 2);
	const frameCount = Math.min(...channels.map((channel) => channel.length));
	if (frameCount === 0) return new Float32Array(width * 2);

	const peaks = new Float32Array(width * 2);
	for (let pixel = 0; pixel < width; pixel += 1) {
		const start = Math.min(frameCount - 1, Math.floor((pixel * frameCount) / width));
		const end = Math.max(start + 1, Math.floor(((pixel + 1) * frameCount) / width));
		let minimum = 1;
		let maximum = -1;
		for (let frame = start; frame < Math.min(frameCount, end); frame += 1) {
			const sample = mixedSample(channels, frame);
			minimum = Math.min(minimum, sample);
			maximum = Math.max(maximum, sample);
		}
		peaks[pixel * 2] = minimum;
		peaks[pixel * 2 + 1] = maximum;
	}
	return peaks;
}
