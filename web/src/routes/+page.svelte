<script lang="ts">
	type Status = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

	let status = $state<Status>('idle');
	let log = $state<string[]>([]);
	let socket: WebSocket | undefined;

	const label: Record<Status, string> = {
		idle: 'Not connected',
		connecting: 'Connecting',
		open: 'Connected',
		closed: 'Closed',
		error: 'Failed'
	};

	function append(line: string): void {
		log = [...log, `${new Date().toLocaleTimeString()}  ${line}`].slice(-12);
	}

	function connect(): void {
		socket?.close();
		status = 'connecting';
		log = [];

		const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const query = new URLSearchParams({ model: 'phase-0-transport-check' });
		const url = `${scheme}//${window.location.host}/v1/realtime?${query}`;

		socket = new WebSocket(url);
		socket.addEventListener('open', () => {
			status = 'open';
			append('socket open');
			socket?.send(JSON.stringify({ type: 'session.update' }));
		});
		socket.addEventListener('message', (event) => append(`recv ${event.data}`));
		socket.addEventListener('error', () => {
			status = 'error';
			append('socket error');
		});
		socket.addEventListener('close', (event) => {
			if (status !== 'error') status = 'closed';
			append(`socket closed (${event.code})`);
		});
	}

	function disconnect(): void {
		socket?.close();
		socket = undefined;
	}
</script>

<svelte:head><title>Speachy - Phase 0</title></svelte:head>

<main>
	<header>
		<p class="eyebrow">Speachy on SvelteKit</p>
		<h1>Phase 0: scaffolding and seams</h1>
		<p class="lede">
			No speech features yet. This phase exists to prove the transport works in both dev and
			production, and to fix the interfaces every later phase depends on. See
			<code>ROADMAP.md</code> for what comes next.
		</p>
	</header>

	<section>
		<h2>Realtime transport check</h2>
		<p>
			The realtime socket is attached by a Vite plugin in dev and by <code>src/server-entry.ts</code
			>
			in production. Both paths run the same code, so this button proves the same thing either way.
		</p>

		<div class="controls">
			<button onclick={connect} disabled={status === 'connecting' || status === 'open'}>
				Connect
			</button>
			<button onclick={disconnect} disabled={status !== 'open'}>Disconnect</button>
			<span class="status" data-status={status}>{label[status]}</span>
		</div>

		{#if log.length > 0}
			<ol class="log">
				{#each log as line, index (index)}
					<li>{line}</li>
				{/each}
			</ol>
		{/if}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #0e1417;
		color: #e6edf0;
		font-family: 'Segoe UI', system-ui, sans-serif;
		line-height: 1.6;
	}

	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 4rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 2.5rem;
	}

	.eyebrow {
		margin: 0 0 0.5rem;
		font-family: ui-monospace, 'Cascadia Code', monospace;
		font-size: 0.72rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: #4fbcc6;
	}

	h1 {
		margin: 0 0 0.75rem;
		font-size: 2rem;
		line-height: 1.15;
	}

	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}

	.lede,
	section p {
		margin: 0 0 1rem;
		color: #a3b2ba;
	}

	code {
		font-family: ui-monospace, 'Cascadia Code', monospace;
		font-size: 0.86em;
		background: #1d272c;
		padding: 0.1em 0.35em;
		border-radius: 3px;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	button {
		font: inherit;
		font-size: 0.9rem;
		padding: 0.45rem 1rem;
		border: 1px solid #4fbcc6;
		border-radius: 3px;
		background: transparent;
		color: #4fbcc6;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: #123338;
	}

	button:disabled {
		border-color: #26333a;
		color: #71838c;
		cursor: not-allowed;
	}

	button:focus-visible {
		outline: 2px solid #6fd0d9;
		outline-offset: 2px;
	}

	.status {
		font-family: ui-monospace, 'Cascadia Code', monospace;
		font-size: 0.8rem;
		color: #71838c;
	}

	.status[data-status='open'] {
		color: #4fbcc6;
	}

	.status[data-status='error'] {
		color: #e08a6c;
	}

	.log {
		margin: 1.25rem 0 0;
		padding: 0.85rem 1rem 0.85rem 2.5rem;
		background: #151d21;
		border: 1px solid #26333a;
		border-radius: 4px;
		font-family: ui-monospace, 'Cascadia Code', monospace;
		font-size: 0.76rem;
		color: #a3b2ba;
		overflow-x: auto;
	}

	.log li {
		white-space: pre;
	}
</style>
