<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { settings } from '$lib/stores/settings.svelte';

	let { children } = $props();
	let showKey = $state(false);

	// Route ids here, resolved in the template, so a future base path is applied
	// in one place and the link rule can see the resolve() call.
	const links = [
		{ route: '/', label: 'Overview' },
		{ route: '/stt', label: 'Speech to text' },
		{ route: '/tts', label: 'Text to speech' },
		{ route: '/mic', label: 'Microphone' },
		{ route: '/models', label: 'Models' }
	] as const;

	const isActive = (route: string) =>
		route === '/'
			? page.url.pathname === resolve('/')
			: page.url.pathname.startsWith(resolve(route as '/stt'));
</script>

<div class="shell">
	<header>
		<a class="brand" href={resolve('/')}>speachy</a>
		<nav>
			{#each links as link (link.route)}
				<a href={resolve(link.route)} class:active={isActive(link.route)}>{link.label}</a>
			{/each}
		</nav>
		<div class="key">
			<input
				type={showKey ? 'text' : 'password'}
				placeholder="API key (optional)"
				bind:value={settings.apiKey}
				aria-label="API key"
			/>
			<button type="button" onclick={() => (showKey = !showKey)}>
				{showKey ? 'Hide' : 'Show'}
			</button>
		</div>
	</header>

	<main>{@render children()}</main>
</div>

<style>
	:global(:root) {
		--ground: #f3f6f7;
		--surface: #ffffff;
		--surface-2: #e8eef0;
		--ink: #131a1e;
		--ink-2: #4a5a63;
		--ink-3: #7b8c96;
		--rule: #d3dce0;
		--accent: #0b6e78;
		--accent-ink: #08525a;
		--accent-wash: #dfeff1;
		--danger: #a24a31;
		--mono: 'Cascadia Code', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		--sans: 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif;
	}

	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) {
			--ground: #0e1417;
			--surface: #151d21;
			--surface-2: #1d272c;
			--ink: #e6edf0;
			--ink-2: #a3b2ba;
			--ink-3: #71838c;
			--rule: #26333a;
			--accent: #4fbcc6;
			--accent-ink: #6fd0d9;
			--accent-wash: #123338;
			--danger: #e08a6c;
		}
	}

	:global(:root[data-theme='dark']) {
		--ground: #0e1417;
		--surface: #151d21;
		--surface-2: #1d272c;
		--ink: #e6edf0;
		--ink-2: #a3b2ba;
		--ink-3: #71838c;
		--rule: #26333a;
		--accent: #4fbcc6;
		--accent-ink: #6fd0d9;
		--accent-wash: #123338;
		--danger: #e08a6c;
	}

	:global(body) {
		margin: 0;
		background: var(--ground);
		color: var(--ink);
		font-family: var(--sans);
		line-height: 1.6;
		-webkit-font-smoothing: antialiased;
	}

	:global(h1) {
		font-size: 1.7rem;
		line-height: 1.2;
		margin: 0 0 0.4rem;
	}
	:global(h2) {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}
	:global(p) {
		margin: 0 0 1rem;
		color: var(--ink-2);
	}
	:global(code) {
		font-family: var(--mono);
		font-size: 0.86em;
		background: var(--surface-2);
		padding: 0.1em 0.35em;
		border-radius: 3px;
	}
	:global(label) {
		display: block;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ink-3);
		margin-bottom: 0.3rem;
	}
	:global(input, select, textarea, button) {
		font: inherit;
	}
	:global(input, select, textarea) {
		width: 100%;
		background: var(--surface);
		color: var(--ink);
		border: 1px solid var(--rule);
		border-radius: 3px;
		padding: 0.45rem 0.6rem;
	}
	:global(button) {
		background: var(--accent);
		color: var(--ground);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0.45rem 1rem;
		cursor: pointer;
		font-weight: 600;
	}
	:global(button.secondary) {
		background: transparent;
		color: var(--accent-ink);
	}
	:global(button.danger) {
		background: transparent;
		color: var(--danger);
		border-color: var(--danger);
	}
	:global(button:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:global(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	:global(.card) {
		background: var(--surface);
		border: 1px solid var(--rule);
		border-radius: 4px;
		padding: 1.2rem;
	}
	:global(.error) {
		border-left: 3px solid var(--danger);
		background: var(--surface);
		padding: 0.7rem 0.9rem;
		border-radius: 3px;
		color: var(--danger);
		font-size: 0.9rem;
	}
	:global(.muted) {
		color: var(--ink-3);
		font-size: 0.85rem;
	}

	.shell {
		max-width: 62rem;
		margin: 0 auto;
		padding: 0 1.5rem 5rem;
	}

	header {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		flex-wrap: wrap;
		padding: 1.1rem 0;
		border-bottom: 1px solid var(--rule);
		margin-bottom: 2rem;
	}

	.brand {
		font-family: var(--mono);
		font-size: 0.85rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--accent-ink);
		text-decoration: none;
	}

	nav {
		display: flex;
		gap: 1.1rem;
		flex: 1;
		flex-wrap: wrap;
	}

	nav a {
		color: var(--ink-2);
		text-decoration: none;
		font-size: 0.92rem;
		padding-bottom: 2px;
		border-bottom: 2px solid transparent;
	}

	nav a:hover {
		color: var(--ink);
	}

	nav a.active {
		color: var(--ink);
		border-bottom-color: var(--accent);
	}

	.key {
		display: flex;
		gap: 0.4rem;
		align-items: center;
	}

	.key input {
		width: 13rem;
		font-size: 0.85rem;
		padding: 0.3rem 0.5rem;
	}

	.key button {
		font-size: 0.8rem;
		padding: 0.3rem 0.6rem;
		background: transparent;
		color: var(--ink-2);
		border-color: var(--rule);
		font-weight: 400;
	}
</style>
