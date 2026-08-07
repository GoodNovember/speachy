<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import type { Model } from '$lib/types/api';

	let local = $state<Model[]>([]);
	let loaded = $state<string[]>([]);
	let registry = $state<Model[]>([]);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let loadingRegistry = $state(false);
	let filter = $state('');

	$effect(() => {
		void refresh();
	});

	async function refresh(): Promise<void> {
		try {
			[local, loaded] = await Promise.all([api().listModels(), api().listLoadedModels()]);
			error = null;
		} catch (err) {
			error = message(err);
		}
	}

	async function browseRegistry(): Promise<void> {
		loadingRegistry = true;
		try {
			registry = await api().listRegistry();
			error = null;
		} catch (err) {
			error = message(err);
		} finally {
			loadingRegistry = false;
		}
	}

	async function act(id: string, fn: () => Promise<void>): Promise<void> {
		busy = id;
		try {
			await fn();
			await refresh();
			error = null;
		} catch (err) {
			error = message(err);
		} finally {
			busy = null;
		}
	}

	const message = (err: unknown): string =>
		err instanceof ApiError || err instanceof Error ? err.message : String(err);

	const isLoaded = (id: string) => loaded.includes(id);
	const localIds = $derived(new Set(local.map((m) => m.id)));

	const visibleRegistry = $derived(
		filter.trim() === ''
			? registry
			: registry.filter((m) => m.id.toLowerCase().includes(filter.trim().toLowerCase()))
	);
</script>

<svelte:head><title>Models - speachy</title></svelte:head>

<h1>Models</h1>
<p>
	Local models are on disk. <em>In memory</em> means the model is loaded and serving; the server unloads
	it again after its idle TTL.
</p>

{#if error}<p class="error">{error}</p>{/if}

<section class="card">
	<h2>Local ({local.length})</h2>
	{#if local.length === 0}
		<p class="muted">Nothing downloaded yet. Browse the registry below.</p>
	{:else}
		<ul class="list">
			{#each local as m (m.id)}
				<li>
					<div class="meta">
						<span class="id">{m.id}</span>
						<span class="tags">
							{#if m.task}<span class="tag">{m.task}</span>{/if}
							{#if isLoaded(m.id)}<span class="tag on">in memory</span>{/if}
						</span>
					</div>
					<div class="ops">
						{#if isLoaded(m.id)}
							<button
								class="secondary"
								disabled={busy === m.id}
								onclick={() => act(m.id, () => api().unloadModel(m.id))}
							>
								Unload
							</button>
						{/if}
						<button
							class="danger"
							disabled={busy === m.id}
							onclick={() => act(m.id, () => api().deleteModel(m.id))}
						>
							Delete
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="card registry">
	<h2>Registry</h2>
	{#if registry.length === 0}
		<p class="muted">Lists downloadable models from Hugging Face. This takes a few seconds.</p>
		<button onclick={browseRegistry} disabled={loadingRegistry}>
			{loadingRegistry ? 'Loading...' : 'Browse registry'}
		</button>
	{:else}
		<input placeholder="Filter by name" bind:value={filter} />
		<p class="muted">{visibleRegistry.length} of {registry.length} shown</p>
		<ul class="list">
			{#each visibleRegistry.slice(0, 100) as m (m.id)}
				<li>
					<div class="meta">
						<span class="id">{m.id}</span>
						<span class="tags">
							{#if m.task}<span class="tag">{m.task}</span>{/if}
						</span>
					</div>
					<div class="ops">
						{#if localIds.has(m.id)}
							<span class="muted">downloaded</span>
						{:else}
							<button
								disabled={busy === m.id}
								onclick={() => act(m.id, () => api().downloadModel(m.id))}
							>
								{busy === m.id ? 'Downloading...' : 'Download'}
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		{#if visibleRegistry.length > 100}
			<p class="muted">Showing the first 100. Narrow the filter to see more.</p>
		{/if}
	{/if}
</section>

<style>
	section + section {
		margin-top: 1.2rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.list li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 0.6rem 0;
		border-top: 1px solid var(--rule);
		flex-wrap: wrap;
	}

	.meta {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}

	.id {
		font-family: var(--mono);
		font-size: 0.85rem;
		word-break: break-all;
	}

	.tags {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}

	.tag {
		font-size: 0.68rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
		border: 1px solid var(--rule);
		border-radius: 2px;
		padding: 0.05rem 0.35rem;
	}

	.tag.on {
		color: var(--accent-ink);
		border-color: var(--accent);
		background: var(--accent-wash);
	}

	.ops {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.ops button {
		font-size: 0.82rem;
		padding: 0.25rem 0.7rem;
	}

	.registry input {
		margin-bottom: 0.4rem;
	}
</style>
