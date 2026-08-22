<script lang="ts">
	import { resolve } from '$app/paths';
	import { api } from '$lib/api';

	type Status = 'checking' | 'up' | 'down';

	let status = $state<Status>('checking');
	let detail = $state('');
	let modelCount = $state(0);
	let loadedCount = $state(0);

	$effect(() => {
		void check();
	});

	async function check(): Promise<void> {
		status = 'checking';
		try {
			const [models, loaded] = await Promise.all([api().listModels(), api().listLoadedModels()]);
			modelCount = models.length;
			loadedCount = loaded.length;
			status = 'up';
			detail = '';
		} catch (err) {
			status = 'down';
			detail = err instanceof Error ? err.message : String(err);
		}
	}
</script>

<svelte:head><title>speachy</title></svelte:head>

<h1>speachy</h1>
<p>
	The native SvelteKit control plane. The playground uses the same OpenAI-compatible HTTP routes as
	external clients; Python is now isolated behind the inference worker. See <code>ROADMAP.md</code> for
	where this is going.
</p>

<section class="card status" data-status={status}>
	<div>
		<h2>Native server</h2>
		{#if status === 'checking'}
			<p class="muted">Checking...</p>
		{:else if status === 'up'}
			<p class="muted">
				Connected. {modelCount} model{modelCount === 1 ? '' : 's'} on disk, {loadedCount} in memory.
			</p>
		{:else}
			<p class="error">{detail}</p>
		{/if}
	</div>
	<button class="secondary" onclick={check}>Recheck</button>
</section>

<div class="cards">
	<a class="card link" href={resolve('/stt')}>
		<h2>Speech to text</h2>
		<p>Transcribe a file, with streaming, word timestamps and every response format.</p>
	</a>
	<a class="card link" href={resolve('/models')}>
		<h2>Models</h2>
		<p>See what is on disk and in memory, browse the registry, download and delete.</p>
	</a>
	<a class="card link" href={resolve('/tts')}>
		<h2>Text to speech</h2>
		<p>Generate audio from text, with every voice, format and speed the server supports.</p>
	</a>
	<a class="card link" href={resolve('/mic')}>
		<h2>Microphone</h2>
		<p>Capture to PCM16 at 16 kHz, then transcribe it to prove the pipeline end to end.</p>
	</a>
	<a class="card link" href={resolve('/chat')}>
		<h2>Audio chat</h2>
		<p>Speak or type to a local LLM and hear the reply spoken back.</p>
	</a>
	<a class="card link" href={resolve('/workspace')}>
		<h2>Audio workspace</h2>
		<p>Review recordings, transcripts and speaker turns in a portable local project.</p>
	</a>
	<a class="card link" href={resolve('/realtime')}>
		<h2>Realtime console</h2>
		<p>Live session over the realtime socket, with an inspector for every event both ways.</p>
	</a>
</div>

<style>
	.status {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		border-left: 3px solid var(--ink-3);
		margin-bottom: 1.5rem;
	}

	.status[data-status='up'] {
		border-left-color: var(--accent);
	}
	.status[data-status='down'] {
		border-left-color: var(--danger);
	}
	.status h2 {
		margin-bottom: 0.2rem;
	}
	.status :global(p) {
		margin: 0;
	}

	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: 1rem;
	}

	.link {
		text-decoration: none;
		color: inherit;
		display: block;
	}

	.link:hover {
		border-color: var(--accent);
	}

	.card :global(p) {
		margin: 0;
		font-size: 0.9rem;
	}
</style>
