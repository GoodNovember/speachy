<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		MAX_WAVEFORM_RASTER_WIDTH,
		calculateWaveformPeaks,
		formatWaveformTime,
		waveformRasterWidth,
		waveformRenderWidth,
		waveformTimeForX,
		waveformXForTime
	} from './waveform';

	let { file }: { file: File | null } = $props();

	type DecodeState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'ready' }
		| { status: 'failed'; message: string };

	const WAVEFORM_HEIGHT = 164;
	let canvas = $state<HTMLCanvasElement>();
	let audio = $state<HTMLAudioElement>();
	let audioUrl = $state<string | null>(null);
	let decodeState = $state<DecodeState>({ status: 'idle' });
	let duration = $state(0);
	let currentTime = $state(0);
	let renderWidth = $state(720);
	let requestId = 0;
	let animationFrame: number | undefined;

	const playheadX = $derived(waveformXForTime(currentTime, duration, renderWidth));
	const timeLabel = $derived(
		`${formatWaveformTime(currentTime)} / ${formatWaveformTime(duration)}`
	);
	const density = $derived(duration > 0 ? renderWidth / duration : 0);

	function message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function stopPlayheadAnimation(): void {
		if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
		animationFrame = undefined;
	}

	function updatePlayhead(): void {
		if (audio === undefined) return;
		currentTime = audio.currentTime;
		if (!audio.paused && !audio.ended) animationFrame = requestAnimationFrame(updatePlayhead);
		else animationFrame = undefined;
	}

	function startPlayheadAnimation(): void {
		stopPlayheadAnimation();
		animationFrame = requestAnimationFrame(updatePlayhead);
	}

	function syncNativeDuration(): void {
		if (audio !== undefined && !(duration > 0) && Number.isFinite(audio.duration)) {
			duration = audio.duration;
		}
	}

	function seek(time: number): void {
		if (audio === undefined || !(duration > 0)) return;
		const next = Math.min(duration, Math.max(0, time));
		audio.currentTime = next;
		currentTime = next;
	}

	function seekFromPointer(event: MouseEvent): void {
		if (canvas === undefined) return;
		const bounds = canvas.getBoundingClientRect();
		seek(waveformTimeForX(event.clientX - bounds.left, duration, bounds.width));
	}

	function seekFromKeyboard(event: KeyboardEvent): void {
		const step = event.shiftKey ? 5 : 1;
		let next: number | undefined;
		if (event.key === 'ArrowLeft') next = currentTime - step;
		else if (event.key === 'ArrowRight') next = currentTime + step;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = duration;
		if (next === undefined) return;
		event.preventDefault();
		seek(next);
	}

	function canvasColor(name: string, fallback: string): string {
		if (canvas === undefined) return fallback;
		return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
	}

	function drawWaveform(peaks: Float32Array, decodedDuration: number): void {
		if (canvas === undefined) throw new Error('Waveform canvas is unavailable');
		const context = canvas.getContext('2d');
		if (context === null) throw new Error('Canvas 2D rendering is unavailable');
		const pixelRatio = window.devicePixelRatio || 1;
		const backingWidth = Math.min(
			MAX_WAVEFORM_RASTER_WIDTH,
			Math.max(1, Math.floor(renderWidth * pixelRatio))
		);
		const horizontalScale = backingWidth / renderWidth;
		canvas.width = backingWidth;
		canvas.height = Math.max(1, Math.floor(WAVEFORM_HEIGHT * pixelRatio));
		context.setTransform(horizontalScale, 0, 0, pixelRatio, 0, 0);

		const background = canvasColor('--surface-2', '#e8eef0');
		const grid = canvasColor('--rule', '#d7e0e4');
		const ink = canvasColor('--ink-3', '#7b8c96');
		const waveform = canvasColor('--accent', '#0b6e78');
		context.fillStyle = background;
		context.fillRect(0, 0, renderWidth, WAVEFORM_HEIGHT);

		const secondsPerTick = density >= 64 ? 1 : density >= 20 ? 5 : 10;
		context.strokeStyle = grid;
		context.fillStyle = ink;
		context.font = '10px ui-monospace, monospace';
		context.textBaseline = 'top';
		for (let second = 0; second <= decodedDuration; second += secondsPerTick) {
			const x = waveformXForTime(second, decodedDuration, renderWidth) + 0.5;
			context.beginPath();
			context.moveTo(x, 0);
			context.lineTo(x, WAVEFORM_HEIGHT);
			context.stroke();
			if (second % (secondsPerTick * 5) === 0) {
				context.fillText(formatWaveformTime(second), x + 4, 5);
			}
		}

		const middle = WAVEFORM_HEIGHT / 2 + 6;
		const amplitude = WAVEFORM_HEIGHT * 0.37;
		context.fillStyle = waveform;
		const peakCount = peaks.length / 2;
		const columnWidth = renderWidth / peakCount;
		for (let column = 0; column < peakCount; column += 1) {
			const minimum = peaks[column * 2] ?? 0;
			const maximum = peaks[column * 2 + 1] ?? 0;
			const top = middle - maximum * amplitude;
			const bottom = middle - minimum * amplitude;
			context.fillRect(
				column * columnWidth,
				top,
				Math.max(columnWidth, 1 / horizontalScale),
				Math.max(1, bottom - top)
			);
		}
	}

	async function decode(selected: File, expectedRequest: number): Promise<void> {
		decodeState = { status: 'loading' };
		const context = new AudioContext();
		try {
			const decoded = await context.decodeAudioData(await selected.arrayBuffer());
			if (expectedRequest !== requestId) return;
			const width = waveformRenderWidth(decoded.duration);
			const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
				decoded.getChannelData(index)
			);
			const peaks = calculateWaveformPeaks(channels, waveformRasterWidth(width));
			duration = decoded.duration;
			currentTime = 0;
			renderWidth = width;
			await tick();
			if (expectedRequest !== requestId) return;
			drawWaveform(peaks, decoded.duration);
			decodeState = { status: 'ready' };
		} catch (error) {
			if (expectedRequest === requestId)
				decodeState = { status: 'failed', message: message(error) };
		} finally {
			await context.close().catch(() => undefined);
		}
	}

	$effect(() => {
		const selected = file;
		const expectedRequest = ++requestId;
		stopPlayheadAnimation();
		currentTime = 0;
		duration = 0;
		renderWidth = 720;
		decodeState = selected === null ? { status: 'idle' } : { status: 'loading' };
		if (selected === null) {
			audioUrl = null;
			return;
		}

		const url = URL.createObjectURL(selected);
		audioUrl = url;
		void decode(selected, expectedRequest);
		return () => URL.revokeObjectURL(url);
	});

	onDestroy(stopPlayheadAnimation);
</script>

<section class="waveform-card" aria-label="Selected recording waveform">
	<div class="waveform-heading">
		<div>
			<p class="step">03 / Inspect the recording</p>
			<h2>Waveform and playback</h2>
		</div>
		{#if file !== null}
			<span class="time-readout">{timeLabel}</span>
		{/if}
	</div>

	{#if file === null}
		<p class="waveform-empty">Select a recording above to decode and inspect its waveform.</p>
	{:else}
		<div class="playback-row">
			<audio
				bind:this={audio}
				controls
				preload="metadata"
				src={audioUrl ?? undefined}
				onplay={startPlayheadAnimation}
				onpause={stopPlayheadAnimation}
				onended={stopPlayheadAnimation}
				onseeked={updatePlayhead}
				onloadedmetadata={syncNativeDuration}
			></audio>
			<span class="decode-state" data-status={decodeState.status}>
				{decodeState.status === 'loading'
					? 'Decoding waveform…'
					: decodeState.status === 'ready'
						? `${density.toFixed(1)} px/s`
						: decodeState.status === 'failed'
							? 'Waveform unavailable'
							: 'Waiting'}
			</span>
		</div>

		{#if decodeState.status === 'failed'}
			<p class="decode-error" role="alert">
				Native playback may still work, but the browser could not decode the waveform:
				{decodeState.message}
			</p>
		{/if}

		<div class="waveform-scroll" role="region" aria-label="Horizontally scrollable waveform">
			<div class="waveform-stage" style:width={`${renderWidth}px`}>
				<canvas
					bind:this={canvas}
					onclick={seekFromPointer}
					onkeydown={seekFromKeyboard}
					tabindex="0"
					role="slider"
					style:width={`${renderWidth}px`}
					style:height={`${WAVEFORM_HEIGHT}px`}
					aria-label="Recording playhead"
					aria-valuemin="0"
					aria-valuemax={duration}
					aria-valuenow={currentTime}
					aria-valuetext={timeLabel}
				></canvas>
				<div class="playhead" style:left={`${playheadX}px`} aria-hidden="true"></div>
			</div>
		</div>
		<p class="waveform-help">
			Scroll horizontally with the browser. Click the waveform to seek; use Left/Right for one
			second or Shift for five.
		</p>
	{/if}
</section>

<style>
	.waveform-card {
		margin-top: 1rem;
		border: 1px solid var(--rule);
		border-radius: 4px;
		background: var(--surface);
		overflow: hidden;
	}

	.waveform-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.1rem;
		border-bottom: 1px solid var(--rule);
	}

	.waveform-heading h2 {
		margin: 0;
	}

	.step {
		margin: 0 0 0.35rem;
		font-family: var(--mono);
		font-size: 0.69rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.time-readout,
	.decode-state {
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--ink-3);
		white-space: nowrap;
	}

	.waveform-empty,
	.decode-error,
	.waveform-help {
		margin: 0;
		padding: 0.8rem 1.1rem;
		font-size: 0.82rem;
	}

	.playback-row {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.8rem 1.1rem;
	}

	audio {
		min-width: 15rem;
		max-width: 32rem;
		width: 100%;
		height: 2.5rem;
	}

	.decode-error {
		border-top: 1px solid var(--rule);
		color: var(--danger);
	}

	.waveform-scroll {
		overflow-x: auto;
		overflow-y: hidden;
		border-block: 1px solid var(--rule);
		background: var(--surface-2);
		overscroll-behavior-inline: contain;
		scrollbar-gutter: stable;
	}

	.waveform-scroll:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.waveform-stage {
		position: relative;
		min-width: 100%;
		height: 164px;
	}

	canvas {
		display: block;
		max-width: none;
		cursor: crosshair;
	}

	canvas:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -3px;
	}

	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--danger);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--surface), transparent 45%);
		pointer-events: none;
		transform: translateX(-1px);
	}

	.waveform-help {
		color: var(--ink-3);
	}

	@media (max-width: 46rem) {
		.waveform-heading,
		.playback-row {
			align-items: start;
			flex-direction: column;
		}

		audio {
			min-width: 0;
			max-width: none;
		}
	}
</style>
