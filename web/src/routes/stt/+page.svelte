<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import { RESPONSE_FORMATS, type Model, type ResponseFormat } from '$lib/types/api';

	let models = $state<Model[]>([]);
	let modelsError = $state<string | null>(null);

	let file = $state<File | null>(null);
	let model = $state('');
	let responseFormat = $state<ResponseFormat>('json');
	let language = $state('');
	let wordTimestamps = $state(false);
	let stream = $state(false);

	let running = $state(false);
	let output = $state('');
	let error = $state<string | null>(null);
	let elapsedMs = $state<number | null>(null);
	let controller: AbortController | undefined;

	$effect(() => {
		void loadModels();
	});

	async function loadModels(): Promise<void> {
		try {
			models = await api().listModels('automatic-speech-recognition');
			if (model === '' && models.length > 0) model = models[0].id;
			modelsError = null;
		} catch (err) {
			modelsError = err instanceof Error ? err.message : String(err);
		}
	}

	function onFileChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		file = input.files?.[0] ?? null;
	}

	async function transcribe(): Promise<void> {
		if (file === null || model === '') return;
		controller?.abort();
		controller = new AbortController();

		running = true;
		error = null;
		output = '';
		elapsedMs = null;
		const started = performance.now();

		const options = {
			file,
			fileName: file.name,
			model,
			language: language.trim() || undefined,
			wordTimestamps,
			signal: controller.signal
		};

		try {
			if (stream) {
				// The done event carries an empty transcript, so accumulate deltas.
				for await (const event of api().transcribeStream({ ...options, responseFormat: 'json' })) {
					if (event.type === 'transcript.text.delta') output += event.delta;
				}
			} else if (wordTimestamps || responseFormat === 'verbose_json') {
				const verbose = await api().transcribeVerbose(options);
				output = JSON.stringify(verbose, null, 2);
			} else {
				output = await api().transcribe({ ...options, responseFormat });
			}
			elapsedMs = performance.now() - started;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			error =
				err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
		} finally {
			running = false;
		}
	}

	function cancel(): void {
		controller?.abort();
		running = false;
	}
</script>

<svelte:head><title>Speech to text - speachy</title></svelte:head>

<h1>Speech to text</h1>
<p>
	Transcribes an audio file through <code>/v1/audio/transcriptions</code>. Streaming accumulates
	deltas rather than reading the final event, which the reference server leaves empty.
</p>

{#if modelsError}
	<p class="error">Could not load models: {modelsError}</p>
{/if}

<div class="grid">
	<section class="card controls">
		<div class="field">
			<label for="file">Audio file</label>
			<input id="file" type="file" accept="audio/*,video/*" onchange={onFileChange} />
			{#if file}<p class="muted">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>{/if}
		</div>

		<div class="field">
			<label for="model">Model</label>
			<select id="model" bind:value={model}>
				{#each models as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
			</select>
		</div>

		<div class="row">
			<div class="field">
				<label for="format">Response format</label>
				<select id="format" bind:value={responseFormat} disabled={stream}>
					{#each RESPONSE_FORMATS as f (f)}<option value={f}>{f}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="language">Language</label>
				<input id="language" bind:value={language} placeholder="auto" />
			</div>
		</div>

		<div class="checks">
			<label class="check"><input type="checkbox" bind:checked={stream} /> Stream over SSE</label>
			<label class="check">
				<input type="checkbox" bind:checked={wordTimestamps} disabled={stream} /> Word timestamps
			</label>
		</div>

		<div class="actions">
			<button onclick={transcribe} disabled={running || file === null || model === ''}>
				{running ? 'Transcribing...' : 'Transcribe'}
			</button>
			{#if running}<button class="secondary" onclick={cancel}>Cancel</button>{/if}
		</div>
	</section>

	<section class="card">
		<h2>
			Result
			{#if elapsedMs !== null}<span class="muted">{(elapsedMs / 1000).toFixed(2)}s</span>{/if}
		</h2>
		{#if error}
			<p class="error">{error}</p>
		{:else if output === ''}
			<p class="muted">No transcription yet.</p>
		{:else}
			<pre>{output}</pre>
		{/if}
	</section>
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: minmax(18rem, 22rem) 1fr;
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

	.checks {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.9rem;
		color: var(--ink-2);
		margin: 0;
	}

	.check input {
		width: auto;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
	}

	h2 {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
	}

	pre {
		margin: 0;
		font-family: var(--mono);
		font-size: 0.82rem;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 30rem;
		overflow: auto;
	}
</style>
