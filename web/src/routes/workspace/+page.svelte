<script lang="ts">
	import {
		WORKSPACE_KIND,
		WORKSPACE_MANIFEST_FILENAME,
		WORKSPACE_SCHEMA_VERSION
	} from '$lib/workspace/manifest';
</script>

<svelte:head><title>Audio workspace - speachy</title></svelte:head>

<div class="heading">
	<div>
		<p class="eyebrow">Local review environment</p>
		<h1>Audio workspace</h1>
	</div>
	<span class="state">No workspace open</span>
</div>

<p class="lede">
	A workspace keeps original recordings, raw transcription and diarization results, and derived
	alignment artifacts together in a directory you control. Browser permissions and transient
	interface state stay on this device.
</p>

<div class="grid">
	<section class="card primary">
		<p class="step">01 / Choose a directory</p>
		<h2>Open a portable audio project</h2>
		<p>
			Speachy recognizes a directory only when its root contains
			<code>{WORKSPACE_MANIFEST_FILENAME}</code>. Directory access is never inferred from a path or
			requested on page load.
		</p>
		<p class="muted">
			The direct directory picker and explicit initialization action are the next workspace slice.
		</p>
	</section>

	<section class="card contract">
		<p class="step">Workspace contract</p>
		<h2>{WORKSPACE_MANIFEST_FILENAME}</h2>
		<dl>
			<div>
				<dt>Kind</dt>
				<dd>{WORKSPACE_KIND}</dd>
			</div>
			<div>
				<dt>Schema</dt>
				<dd>Version {WORKSPACE_SCHEMA_VERSION}</dd>
			</div>
			<div>
				<dt>Paths</dt>
				<dd>Root-relative, portable</dd>
			</div>
			<div>
				<dt>Newer versions</dt>
				<dd>Open read-only</dd>
			</div>
		</dl>
	</section>
</div>

<section class="boundary">
	<h2>Ownership boundary</h2>
	<div class="boundary-grid">
		<div>
			<strong>Portable</strong>
			<p>Workspace identity, directory preferences, audio, analysis, and diagnostics.</p>
		</div>
		<div>
			<strong>Browser-local</strong>
			<p>Directory permission handles, last-open state, caches, and interface preferences.</p>
		</div>
		<div>
			<strong>Transient</strong>
			<p>Playhead position, active panels, selections, and unfinished realtime state.</p>
		</div>
	</div>
</section>

<style>
	.heading {
		display: flex;
		justify-content: space-between;
		align-items: end;
		gap: 1rem;
		margin-bottom: 0.8rem;
	}

	.eyebrow,
	.step {
		margin: 0 0 0.35rem;
		font-family: var(--mono);
		font-size: 0.69rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}

	.state {
		border: 1px solid var(--rule);
		border-radius: 999px;
		padding: 0.25rem 0.65rem;
		font-size: 0.75rem;
		color: var(--ink-3);
		white-space: nowrap;
	}

	.lede {
		max-width: 47rem;
		font-size: 1.02rem;
		margin-bottom: 1.6rem;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.35fr) minmax(16rem, 0.8fr);
		gap: 1rem;
		align-items: stretch;
	}

	.primary {
		border-top: 3px solid var(--accent);
	}

	.primary h2,
	.contract h2 {
		font-size: 1.15rem;
	}

	.contract h2 {
		font-family: var(--mono);
		font-size: 0.92rem;
		word-break: break-word;
	}

	dl {
		margin: 1rem 0 0;
	}

	dl div {
		display: grid;
		grid-template-columns: 7rem minmax(0, 1fr);
		gap: 0.8rem;
		padding: 0.45rem 0;
		border-top: 1px solid var(--rule);
	}

	dt {
		font-size: 0.7rem;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	dd {
		margin: 0;
		font-family: var(--mono);
		font-size: 0.77rem;
		word-break: break-word;
	}

	.boundary {
		margin-top: 1.7rem;
		padding-top: 1.3rem;
		border-top: 1px solid var(--rule);
	}

	.boundary-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1.2rem;
	}

	.boundary strong {
		font-size: 0.83rem;
	}

	.boundary p {
		margin: 0.25rem 0 0;
		font-size: 0.82rem;
	}

	@media (max-width: 46rem) {
		.grid,
		.boundary-grid {
			grid-template-columns: 1fr;
		}

		.heading {
			align-items: start;
			flex-direction: column;
		}
	}
</style>
