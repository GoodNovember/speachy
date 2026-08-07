<script lang="ts">
	import { api } from '$lib/api';
	import { MicRecorder } from '$lib/audio/recorder';
	import { RealtimeSession } from '$lib/realtime/session.svelte';
	import type { Model } from '$lib/types/api';

	const session = new RealtimeSession();

	let models = $state<Model[]>([]);
	let model = $state('');
	let language = $state('en');

	let recorder: MicRecorder | undefined;
	let recording = $state(false);
	let level = $state(0);
	let micError = $state<string | null>(null);

	let filter = $state('');
	let hideAudioFrames = $state(true);
	let selected = $state<number | null>(null);

	$effect(() => {
		void (async () => {
			try {
				models = await api().listModels('automatic-speech-recognition');
				if (model === '' && models.length > 0) model = models[0].id;
			} catch {
				// the overview page reports connectivity problems
			}
		})();
	});

	$effect(() => () => {
		void recorder?.stop();
		session.disconnect();
	});

	function connect(): void {
		if (model === '') return;
		session.connect({ model, intent: 'transcription', language: language.trim() || undefined });
	}

	async function startMic(): Promise<void> {
		micError = null;
		try {
			recorder = new MicRecorder({
				frameSize: 1600, // 100ms at 16 kHz
				onFrame: (frame) => session.sendAudio(frame),
				onLevel: (value) => (level = value)
			});
			await recorder.start();
			recording = true;
		} catch (err) {
			micError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			recorder = undefined;
		}
	}

	async function stopMic(): Promise<void> {
		await recorder?.stop();
		recorder = undefined;
		recording = false;
		level = 0;
		session.commit();
	}

	const visible = $derived(
		session.events.filter((event) => {
			if (hideAudioFrames && event.type === 'input_audio_buffer.append') return false;
			if (filter.trim() === '') return true;
			return event.type.toLowerCase().includes(filter.trim().toLowerCase());
		})
	);

	const selectedEvent = $derived(visible.find((e) => e.id === selected) ?? null);
</script>

<svelte:head><title>Realtime console - speachy</title></svelte:head>

<h1>Realtime console</h1>
<p>
	Opens a session on <code>/v1/realtime</code>, streams microphone audio as PCM16 at 16 kHz and
	shows every event in both directions. Replaces the pre-built React console that used to be
	committed to the repo as a bundle.
</p>

{#if session.error}<p class="error">{session.error}</p>{/if}
{#if micError}<p class="error">{micError}</p>{/if}

<section class="card bar">
	<div class="field">
		<label for="model">Transcription model</label>
		<select id="model" bind:value={model} disabled={session.isOpen}>
			{#each models as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
		</select>
	</div>
	<div class="field lang">
		<label for="lang">Language</label>
		<input id="lang" bind:value={language} placeholder="auto" disabled={session.isOpen} />
	</div>
	<div class="ops">
		{#if session.isOpen}
			<button class="secondary" onclick={() => session.disconnect()}>Disconnect</button>
			{#if recording}
				<button onclick={stopMic}>Stop and commit</button>
			{:else}
				<button onclick={startMic}>Start talking</button>
			{/if}
		{:else}
			<button onclick={connect} disabled={model === ''}>Connect</button>
		{/if}
	</div>
</section>

<div class="status">
	<span class="pill" data-status={session.status}>{session.status}</span>
	{#if session.sessionId}<span class="mono">{session.sessionId}</span>{/if}
	{#if session.isOpen}
		<span class="pill" class:on={session.speaking}>{session.speaking ? 'speech' : 'silence'}</span>
		<span class="muted">{session.audioChunksSent} audio frames sent</span>
	{/if}
	{#if recording}
		<div class="meter" aria-hidden="true">
			<div class="fill" style:width="{Math.min(100, level * 300)}%"></div>
		</div>
	{/if}
</div>

<div class="grid">
	<section class="card">
		<h2>Transcript</h2>
		{#if session.transcripts.length === 0}
			<p class="muted">
				Nothing transcribed yet. Connect, start talking, then stop to commit the buffer.
			</p>
		{:else}
			<ol class="transcript">
				{#each session.transcripts as line, index (index)}<li>{line}</li>{/each}
			</ol>
		{/if}
	</section>

	<section class="card">
		<h2>Events <span class="muted">{visible.length} of {session.events.length}</span></h2>
		<div class="filters">
			<input placeholder="Filter by type" bind:value={filter} />
			<label class="check">
				<input type="checkbox" bind:checked={hideAudioFrames} /> Hide audio frames
			</label>
		</div>

		{#if visible.length === 0}
			<p class="muted">No events yet.</p>
		{:else}
			<ol class="events">
				{#each visible as event (event.id)}
					<li>
						<button
							class="row"
							class:active={selected === event.id}
							onclick={() => (selected = selected === event.id ? null : event.id)}
						>
							<span class="dir" data-dir={event.direction}
								>{event.direction === 'in' ? '<-' : '->'}</span
							>
							<span class="type">{event.type}</span>
							<span class="at">+{event.atMs}ms</span>
						</button>
					</li>
				{/each}
			</ol>
		{/if}

		{#if selectedEvent}
			<pre>{JSON.stringify(selectedEvent.payload, null, 2)}</pre>
		{/if}
	</section>
</div>

<style>
	.bar {
		display: flex;
		gap: 1rem;
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: 0.9rem;
	}

	.bar .field {
		flex: 1;
		min-width: 12rem;
	}
	.bar .field.lang {
		flex: 0 0 7rem;
		min-width: 6rem;
	}

	.ops {
		display: flex;
		gap: 0.5rem;
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		flex-wrap: wrap;
		margin-bottom: 1.2rem;
		font-size: 0.85rem;
	}

	.pill {
		font-family: var(--mono);
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		border: 1px solid var(--rule);
		border-radius: 2px;
		padding: 0.1rem 0.4rem;
		color: var(--ink-3);
	}

	.pill[data-status='open'],
	.pill.on {
		color: var(--accent-ink);
		border-color: var(--accent);
		background: var(--accent-wash);
	}

	.pill[data-status='error'] {
		color: var(--danger);
		border-color: var(--danger);
	}

	.mono {
		font-family: var(--mono);
		font-size: 0.78rem;
		color: var(--ink-3);
	}

	.meter {
		flex: 1;
		min-width: 6rem;
		height: 0.4rem;
		background: var(--surface-2);
		border-radius: 3px;
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 60ms linear;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(16rem, 1fr) minmax(20rem, 1.4fr);
		gap: 1.2rem;
		align-items: start;
	}

	@media (max-width: 56rem) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	h2 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	.transcript {
		margin: 0;
		padding-left: 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.filters {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		margin-bottom: 0.7rem;
		flex-wrap: wrap;
	}

	.filters input:not([type='checkbox']) {
		flex: 1;
		min-width: 8rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.85rem;
		color: var(--ink-2);
		white-space: nowrap;
	}

	.check input {
		width: auto;
	}

	.events {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 22rem;
		overflow-y: auto;
		border: 1px solid var(--rule);
		border-radius: 3px;
	}

	.row {
		display: grid;
		grid-template-columns: 1.8rem 1fr auto;
		gap: 0.6rem;
		align-items: baseline;
		width: 100%;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--rule);
		border-radius: 0;
		color: var(--ink);
		font-weight: 400;
		text-align: left;
		padding: 0.3rem 0.6rem;
		font-family: var(--mono);
		font-size: 0.76rem;
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-2);
	}

	.row.active {
		background: var(--accent-wash);
	}

	.dir[data-dir='in'] {
		color: var(--accent-ink);
	}
	.dir[data-dir='out'] {
		color: var(--ink-3);
	}

	.at {
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}

	pre {
		margin: 0.7rem 0 0;
		background: var(--surface-2);
		border-radius: 3px;
		padding: 0.7rem 0.8rem;
		font-family: var(--mono);
		font-size: 0.76rem;
		max-height: 18rem;
		overflow: auto;
	}
</style>
