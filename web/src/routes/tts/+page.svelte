<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { SPEECH_FORMATS, type Model, type SpeechFormat, type Voice } from '$lib/types/api';

	let models = $state<Model[]>([]);
	let voices = $state<Voice[]>([]);
	let model = $state('');
	let voice = $state('');
	let text = $state('The quick brown fox jumps over the lazy dog.');
	let speed = $state(1);
	let format = $state<SpeechFormat>('wav');

	let running = $state(false);
	let error = $state<string | null>(null);
	let audioUrl = $state<string | null>(null);
	let elapsedMs = $state<number | null>(null);
	let byteLength = $state(0);

	$effect(() => {
		void load();
	});

	// Release the previous blob URL when a new one replaces it.
	$effect(() => {
		const current = audioUrl;
		return () => {
			if (current !== null) URL.revokeObjectURL(current);
		};
	});

	async function load(): Promise<void> {
		try {
			[models, voices] = await Promise.all([api().listSpeechModels(), api().listVoices()]);
			if (model === '' && models.length > 0) model = models[0].id;
			if (voice === '' && voices.length > 0) voice = voices[0].name ?? voices[0].id ?? '';
			error = null;
		} catch (err) {
			error = message(err);
		}
	}

	const message = (err: unknown): string =>
		err instanceof ApiError || err instanceof Error ? err.message : String(err);

	async function synthesize(): Promise<void> {
		if (model === '' || voice === '' || text.trim() === '') return;
		running = true;
		error = null;
		elapsedMs = null;
		const started = performance.now();
		try {
			const blob = await api().synthesize({
				model,
				voice,
				input: text,
				responseFormat: format,
				speed
			});
			byteLength = blob.size;
			elapsedMs = performance.now() - started;
			audioUrl = URL.createObjectURL(blob);
		} catch (err) {
			error = message(err);
		} finally {
			running = false;
		}
	}

	const voiceLabel = (v: Voice): string => {
		const name = v.name ?? v.id ?? '';
		const parts = [v.language, v.gender].filter(Boolean);
		return parts.length > 0 ? `${name} (${parts.join(', ')})` : name;
	};
</script>

<svelte:head><title>Text to speech - speachy</title></svelte:head>

<h1>Text to speech</h1>
<p>
	Generates audio through <code>/v1/audio/speech</code>. Every format except <code>pcm</code> is encoded
	by ffmpeg on the server, so if one of them fails while pcm works, suspect ffmpeg rather than the model.
</p>

{#if error}<p class="error">{error}</p>{/if}

<div class="grid">
	<section class="card controls">
		<div class="field">
			<label for="text">Text</label>
			<textarea id="text" rows="5" bind:value={text}></textarea>
		</div>

		<div class="field">
			<label for="model">Model</label>
			<select id="model" bind:value={model}>
				{#each models as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
			</select>
		</div>

		<div class="field">
			<label for="voice">Voice ({voices.length})</label>
			<select id="voice" bind:value={voice}>
				{#each voices as v (v.id ?? v.name)}
					<option value={v.name ?? v.id}>{voiceLabel(v)}</option>
				{/each}
			</select>
		</div>

		<div class="row">
			<div class="field">
				<label for="format">Format</label>
				<select id="format" bind:value={format}>
					{#each SPEECH_FORMATS as f (f)}<option value={f}>{f}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="speed">Speed: {speed.toFixed(2)}</label>
				<input id="speed" type="range" min="0.5" max="2" step="0.05" bind:value={speed} />
			</div>
		</div>

		<button onclick={synthesize} disabled={running || model === '' || text.trim() === ''}>
			{running ? 'Generating...' : 'Generate speech'}
		</button>
	</section>

	<section class="card">
		<h2>
			Audio
			{#if elapsedMs !== null}
				<span class="muted"
					>{(elapsedMs / 1000).toFixed(2)}s / {(byteLength / 1024).toFixed(0)} KB</span
				>
			{/if}
		</h2>
		{#if audioUrl === null}
			<p class="muted">Nothing generated yet.</p>
		{:else}
			<audio controls autoplay src={audioUrl}></audio>
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- blob: URL download, not app navigation -->
			<a class="download" href={audioUrl} download={`speech.${format}`}>Download {format}</a>
			{#if format === 'pcm'}
				<p class="muted">
					Raw pcm has no container, so most browsers will not play it inline. Download it to
					inspect.
				</p>
			{/if}
		{/if}
	</section>
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: minmax(18rem, 24rem) 1fr;
		gap: 1.2rem;
		align-items: start;
	}

	@media (max-width: 52rem) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.controls {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.8rem;
	}

	textarea {
		resize: vertical;
		font-family: inherit;
	}

	h2 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
	}

	audio {
		width: 100%;
		margin-bottom: 0.7rem;
	}

	.download {
		font-size: 0.85rem;
		color: var(--accent-ink);
	}
</style>
