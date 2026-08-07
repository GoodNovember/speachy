<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { MicRecorder, type MicRecorderInfo } from '$lib/audio/recorder';
	import { encodeWav } from '$lib/audio/pcm';
	import type { Model } from '$lib/types/api';

	let recorder: MicRecorder | undefined;
	let recording = $state(false);
	let info = $state<MicRecorderInfo | null>(null);
	let level = $state(0);
	let peak = $state(0);
	let framesSeen = $state(0);

	let wavUrl = $state<string | null>(null);
	let duration = $state(0);
	let sampleCount = $state(0);
	let capturedWav = $state<Blob | null>(null);

	let models = $state<Model[]>([]);
	let model = $state('');
	let transcript = $state<string | null>(null);
	let transcribing = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		void (async () => {
			try {
				models = await api().listModels('automatic-speech-recognition');
				if (model === '' && models.length > 0) model = models[0].id;
			} catch {
				// the status card on the overview page already reports this
			}
		})();
	});

	// Revoke the previous object URL whenever a new capture replaces it.
	$effect(() => {
		const current = wavUrl;
		return () => {
			if (current !== null) URL.revokeObjectURL(current);
		};
	});

	async function start(): Promise<void> {
		error = null;
		transcript = null;
		peak = 0;
		framesSeen = 0;
		try {
			recorder = new MicRecorder({
				onLevel: (value) => {
					level = value;
					if (value > peak) peak = value;
					framesSeen += 1;
				}
			});
			info = await recorder.start();
			recording = true;
		} catch (err) {
			error =
				err instanceof Error ? `${err.name}: ${err.message}` : 'Could not open the microphone.';
			recorder = undefined;
		}
	}

	async function stop(): Promise<void> {
		if (recorder === undefined) return;
		const result = await recorder.stop();
		recorder = undefined;
		recording = false;
		level = 0;

		duration = result.durationSeconds;
		sampleCount = result.pcm.length;
		const blob = new Blob([encodeWav(result.pcm, result.sampleRate)], { type: 'audio/wav' });
		capturedWav = blob;
		wavUrl = URL.createObjectURL(blob);
	}

	async function transcribe(): Promise<void> {
		if (capturedWav === null || model === '') return;
		transcribing = true;
		error = null;
		transcript = null;
		try {
			transcript = await api().transcribe({
				file: capturedWav,
				fileName: 'microphone.wav',
				model
			});
		} catch (err) {
			error = err instanceof ApiError || err instanceof Error ? err.message : String(err);
		} finally {
			transcribing = false;
		}
	}
</script>

<svelte:head><title>Microphone - speachy</title></svelte:head>

<h1>Microphone capture</h1>
<p>
	Proves the capture pipeline the realtime console will depend on: microphone to PCM16 at 16 kHz,
	the format the realtime input buffer expects. Record a few seconds of speech, then transcribe it.
	If the transcript reads back correctly, capture, resampling and PCM conversion are all correct.
</p>

{#if error}<p class="error">{error}</p>{/if}

<div class="grid">
	<section class="card">
		<h2>Capture</h2>

		<div class="meter" aria-hidden="true">
			<div class="fill" style:width="{Math.min(100, level * 300)}%"></div>
		</div>

		<div class="actions">
			{#if recording}
				<button onclick={stop}>Stop</button>
			{:else}
				<button onclick={start}>Record</button>
			{/if}
		</div>

		{#if info}
			<dl class="facts">
				<div>
					<dt>Context rate</dt>
					<dd>{info.contextSampleRate.toLocaleString()} Hz</dd>
				</div>
				<div>
					<dt>Target rate</dt>
					<dd>{info.targetSampleRate.toLocaleString()} Hz</dd>
				</div>
				<div>
					<dt>Resampling</dt>
					<dd>{info.resamplingInJs ? 'in JS (fallback)' : 'native (browser)'}</dd>
				</div>
				<div>
					<dt>Frames</dt>
					<dd>{framesSeen}</dd>
				</div>
				<div>
					<dt>Peak level</dt>
					<dd>{peak.toFixed(3)}</dd>
				</div>
			</dl>
			{#if peak === 0 && framesSeen > 0}
				<p class="error">
					Frames are arriving but every one is silent. Check the input device and that the browser
					has microphone permission.
				</p>
			{/if}
		{/if}
	</section>

	<section class="card">
		<h2>Result</h2>
		{#if wavUrl === null}
			<p class="muted">Nothing captured yet.</p>
		{:else}
			<dl class="facts">
				<div>
					<dt>Duration</dt>
					<dd>{duration.toFixed(2)}s</dd>
				</div>
				<div>
					<dt>Samples</dt>
					<dd>{sampleCount.toLocaleString()}</dd>
				</div>
			</dl>

			<audio controls src={wavUrl}></audio>

			<div class="actions">
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- blob: URL download, not app navigation -->
				<a class="download" href={wavUrl} download="microphone.wav">Download WAV</a>
				<button onclick={transcribe} disabled={transcribing || model === ''}>
					{transcribing ? 'Transcribing...' : 'Transcribe it'}
				</button>
			</div>

			<div class="field">
				<label for="model">Model</label>
				<select id="model" bind:value={model}>
					{#each models as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
				</select>
			</div>

			{#if transcript !== null}
				<div class="transcript" class:empty={transcript.trim() === ''}>
					{transcript.trim() === ''
						? 'Empty transcript - the capture was probably silent.'
						: transcript}
				</div>
			{/if}
		{/if}
	</section>
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.2rem;
		align-items: start;
	}

	@media (max-width: 52rem) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.meter {
		height: 0.55rem;
		background: var(--surface-2);
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 1rem;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 60ms linear;
	}

	.actions {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}

	.download {
		font-size: 0.85rem;
		color: var(--accent-ink);
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.7rem;
		margin: 0 0 1rem;
	}

	.facts dt {
		font-size: 0.68rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.facts dd {
		margin: 0;
		font-family: var(--mono);
		font-size: 0.85rem;
	}

	audio {
		width: 100%;
		margin-bottom: 1rem;
	}

	.transcript {
		margin-top: 1rem;
		padding: 0.8rem 0.9rem;
		border-left: 3px solid var(--accent);
		background: var(--surface-2);
		border-radius: 3px;
		font-size: 0.95rem;
	}

	.transcript.empty {
		border-left-color: var(--danger);
		color: var(--danger);
		font-size: 0.88rem;
	}
</style>
