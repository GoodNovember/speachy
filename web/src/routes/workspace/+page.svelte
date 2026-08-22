<script lang="ts">
	import { onMount } from 'svelte';
	import {
		initializeWorkspaceDirectory,
		queryWorkspacePermission,
		readWorkspaceManifest,
		readWorkspaceManifestFromFolderFiles,
		requestWorkspacePermission,
		type PermissionedDirectoryHandle,
		type WorkspaceManifestRead
	} from '$lib/workspace/directory';
	import { loadLastWorkspaceHandle, rememberWorkspaceHandle } from '$lib/workspace/handle-store';
	import {
		WORKSPACE_KIND,
		WORKSPACE_MANIFEST_FILENAME,
		WORKSPACE_SCHEMA_VERSION,
		type WorkspaceManifestInspection,
		type WorkspaceManifestV1
	} from '$lib/workspace/manifest';

	type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<PermissionedDirectoryHandle>;

	type WorkspaceView =
		| { status: 'idle' }
		| { status: 'permission'; handle: PermissionedDirectoryHandle; directoryName: string }
		| {
				status: 'uninitialized';
				directoryName: string;
				handle?: PermissionedDirectoryHandle;
		  }
		| {
				status: 'ready';
				directoryName: string;
				access: 'read-write' | 'read-only';
				manifest: WorkspaceManifestV1;
		  }
		| { status: 'newer-schema'; directoryName: string; schemaVersion: number }
		| {
				status: 'invalid';
				directoryName: string;
				issues: { path: string[]; message: string }[];
		  };

	let capability = $state<'checking' | 'picker' | 'fallback'>('checking');
	let view = $state<WorkspaceView>({ status: 'idle' });
	let workspaceName = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const stateLabel = $derived.by(() => {
		switch (view.status) {
			case 'permission':
				return 'Permission needed';
			case 'uninitialized':
				return 'Not initialized';
			case 'ready':
				return view.access === 'read-write' ? 'Workspace open' : 'Read-only';
			case 'newer-schema':
				return 'Read-only';
			case 'invalid':
				return 'Invalid manifest';
			default:
				return 'No workspace open';
		}
	});

	onMount(() => {
		const picker = directoryPicker();
		capability = picker === undefined ? 'fallback' : 'picker';
		if (picker !== undefined) void restoreLastWorkspace();
	});

	function directoryPicker(): DirectoryPicker | undefined {
		const picker = (window as Window & { showDirectoryPicker?: DirectoryPicker })
			.showDirectoryPicker;
		return picker?.bind(window);
	}

	function message(value: unknown): string {
		return value instanceof Error ? value.message : String(value);
	}

	function clearFeedback(): void {
		error = null;
		notice = null;
	}

	async function remember(manifest: WorkspaceManifestV1, handle: PermissionedDirectoryHandle) {
		try {
			await rememberWorkspaceHandle(manifest.id, handle);
		} catch (storageError) {
			notice = `Workspace opened, but this browser could not remember the directory: ${message(storageError)}`;
		}
	}

	async function applyInspection(
		inspection: WorkspaceManifestInspection,
		directoryName: string,
		handle?: PermissionedDirectoryHandle
	): Promise<void> {
		switch (inspection.status) {
			case 'ready':
				view = {
					status: 'ready',
					directoryName,
					access: handle === undefined ? 'read-only' : 'read-write',
					manifest: inspection.manifest
				};
				if (handle !== undefined) await remember(inspection.manifest, handle);
				break;
			case 'newer-schema':
				view = { status: 'newer-schema', directoryName, schemaVersion: inspection.schemaVersion };
				break;
			case 'invalid':
				view = { status: 'invalid', directoryName, issues: inspection.issues };
				break;
		}
	}

	async function applyRead(
		read: WorkspaceManifestRead,
		directoryName: string,
		handle?: PermissionedDirectoryHandle
	): Promise<void> {
		if (read.status === 'missing') {
			view = { status: 'uninitialized', directoryName, handle };
			workspaceName = directoryName;
			return;
		}
		await applyInspection(read.inspection, directoryName, handle);
	}

	async function openHandle(handle: PermissionedDirectoryHandle): Promise<void> {
		await applyRead(await readWorkspaceManifest(handle), handle.name, handle);
	}

	async function restoreLastWorkspace(): Promise<void> {
		try {
			const handle = await loadLastWorkspaceHandle();
			if (handle === undefined) return;
			if ((await queryWorkspacePermission(handle)) === 'granted') await openHandle(handle);
			else view = { status: 'permission', handle, directoryName: handle.name };
		} catch (restoreError) {
			notice = `The previous workspace could not be restored: ${message(restoreError)}`;
		}
	}

	async function pickWorkspace(): Promise<void> {
		const picker = directoryPicker();
		if (picker === undefined) return;
		busy = true;
		clearFeedback();
		try {
			const handle = await picker({ mode: 'readwrite' });
			let permission = await queryWorkspacePermission(handle);
			if (permission !== 'granted') permission = await requestWorkspacePermission(handle);
			if (permission !== 'granted') {
				view = { status: 'permission', handle, directoryName: handle.name };
				return;
			}
			await openHandle(handle);
		} catch (pickError) {
			if (pickError instanceof DOMException && pickError.name === 'AbortError') return;
			error = message(pickError);
		} finally {
			busy = false;
		}
	}

	async function restorePermission(): Promise<void> {
		if (view.status !== 'permission') return;
		busy = true;
		clearFeedback();
		const { handle } = view;
		try {
			if ((await requestWorkspacePermission(handle)) !== 'granted') {
				error = 'Read/write permission was not granted.';
				return;
			}
			await openHandle(handle);
		} catch (permissionError) {
			error = message(permissionError);
		} finally {
			busy = false;
		}
	}

	async function initializeWorkspace(): Promise<void> {
		if (view.status !== 'uninitialized' || view.handle === undefined) return;
		busy = true;
		clearFeedback();
		const { handle, directoryName } = view;
		try {
			const manifest = await initializeWorkspaceDirectory(handle, workspaceName);
			view = { status: 'ready', directoryName, access: 'read-write', manifest };
			await remember(manifest, handle);
		} catch (initializeError) {
			error = message(initializeError);
		} finally {
			busy = false;
		}
	}

	async function openFallback(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		if (input.files === null || input.files.length === 0) return;
		busy = true;
		clearFeedback();
		try {
			const selected = readWorkspaceManifestFromFolderFiles(input.files);
			await applyRead(await selected.read, selected.directoryName);
		} catch (fallbackError) {
			error = message(fallbackError);
		} finally {
			busy = false;
			input.value = '';
		}
	}
</script>

<svelte:head><title>Audio workspace - speachy</title></svelte:head>

<div class="heading">
	<div>
		<p class="eyebrow">Local review environment</p>
		<h1>Audio workspace</h1>
	</div>
	<span class="state" data-status={view.status}>{stateLabel}</span>
</div>

<p class="lede">
	A workspace keeps original recordings, raw transcription and diarization results, and derived
	alignment artifacts together in a directory you control. Browser permissions and transient
	interface state stay on this device.
</p>

{#if error}<p class="error">{error}</p>{/if}
{#if notice}<p class="notice">{notice}</p>{/if}

<div class="grid">
	<section class="card primary">
		<p class="step">01 / Choose a directory</p>
		<h2>Open a portable audio project</h2>
		<p>
			Speachy recognizes a directory only when its root contains
			<code>{WORKSPACE_MANIFEST_FILENAME}</code>. Access is requested only from the button below.
		</p>

		{#if capability === 'checking'}
			<button disabled>Checking browser support...</button>
		{:else if capability === 'picker'}
			<div class="actions">
				<button onclick={pickWorkspace} disabled={busy}>
					{busy ? 'Opening...' : 'Open Audio Workspace'}
				</button>
				<span class="muted">Read/write directory access</span>
			</div>
		{:else}
			<input
				class="folder-input"
				id="workspace-folder"
				type="file"
				multiple
				webkitdirectory
				onchange={openFallback}
			/>
			<label class="folder-button" for="workspace-folder">Select Workspace Folder</label>
			<p class="muted fallback-copy">
				This browser provides read-only folder selection. New recordings and analysis artifacts will
				be offered as downloads instead of being written into the folder.
			</p>
		{/if}
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

{#if view.status === 'permission'}
	<section class="card result warning">
		<p class="step">Saved workspace</p>
		<h2>Reconnect {view.directoryName}</h2>
		<p>The browser remembered this directory, but requires permission again before reading it.</p>
		<button onclick={restorePermission} disabled={busy}>
			{busy ? 'Requesting...' : 'Restore Access'}
		</button>
	</section>
{:else if view.status === 'uninitialized'}
	<section class="card result warning">
		<p class="step">Uninitialized directory</p>
		<h2>{view.directoryName}</h2>
		<p>
			No root <code>{WORKSPACE_MANIFEST_FILENAME}</code> was found. Nothing has been written.
		</p>
		{#if view.handle}
			<div class="initialize">
				<div>
					<label for="workspace-name">Workspace name</label>
					<input id="workspace-name" maxlength="120" bind:value={workspaceName} />
				</div>
				<button onclick={initializeWorkspace} disabled={busy || workspaceName.length === 0}>
					{busy ? 'Initializing...' : 'Initialize Workspace'}
				</button>
			</div>
			<p class="muted">
				This explicit action creates <code>recordings/</code>, <code>analysis/</code>, and the
				manifest.
			</p>
		{:else}
			<p class="muted">
				Read-only folder selection cannot initialize a directory. Add a valid manifest manually or
				open this folder in a browser with File System Access support.
			</p>
		{/if}
	</section>
{:else if view.status === 'ready'}
	<section class="card result ready">
		<p class="step">Active workspace</p>
		<h2>{view.manifest.name}</h2>
		<dl class="workspace-facts">
			<div>
				<dt>Directory</dt>
				<dd>{view.directoryName}</dd>
			</div>
			<div>
				<dt>Access</dt>
				<dd>{view.access}</dd>
			</div>
			<div>
				<dt>Workspace ID</dt>
				<dd>{view.manifest.id}</dd>
			</div>
			<div>
				<dt>Recordings</dt>
				<dd>{view.manifest.recordingsDirectory}</dd>
			</div>
			<div>
				<dt>Analysis</dt>
				<dd>{view.manifest.analysisDirectory}</dd>
			</div>
		</dl>
	</section>
{:else if view.status === 'newer-schema'}
	<section class="card result warning">
		<p class="step">Compatibility boundary</p>
		<h2>{view.directoryName} is read-only</h2>
		<p>
			This workspace uses schema version {view.schemaVersion}; this build understands version
			{WORKSPACE_SCHEMA_VERSION}. The manifest was not interpreted or changed.
		</p>
	</section>
{:else if view.status === 'invalid'}
	<section class="card result invalid">
		<p class="step">Manifest rejected</p>
		<h2>{view.directoryName}</h2>
		<p>No files were changed. Correct these issues and open the directory again:</p>
		<ul>
			{#each view.issues as issue, index (`${index}:${issue.path.join('.')}:${issue.message}`)}
				<li><code>{issue.path.join('.') || '(root)'}</code> — {issue.message}</li>
			{/each}
		</ul>
	</section>
{/if}

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

	.state[data-status='ready'] {
		border-color: var(--accent);
		color: var(--accent-ink);
		background: var(--accent-wash);
	}

	.lede {
		max-width: 47rem;
		font-size: 1.02rem;
		margin-bottom: 1.6rem;
	}

	.notice {
		border-left: 3px solid var(--accent);
		background: var(--surface);
		padding: 0.7rem 0.9rem;
		border-radius: 3px;
		font-size: 0.88rem;
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

	.actions {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		flex-wrap: wrap;
	}

	.folder-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.folder-button {
		display: inline-block;
		margin: 0;
		background: var(--accent);
		color: var(--ground);
		border: 1px solid var(--accent);
		border-radius: 3px;
		padding: 0.45rem 1rem;
		cursor: pointer;
		font-size: 1rem;
		font-weight: 600;
		letter-spacing: normal;
		text-transform: none;
	}

	.folder-input:focus-visible + .folder-button {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.fallback-copy {
		margin: 0.8rem 0 0;
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

	.result {
		margin-top: 1rem;
	}

	.result.warning {
		border-left: 3px solid var(--ink-3);
	}

	.result.ready {
		border-left: 3px solid var(--accent);
	}

	.result.invalid {
		border-left: 3px solid var(--danger);
	}

	.result ul {
		margin: 0;
		padding-left: 1.2rem;
		color: var(--danger);
	}

	.initialize {
		display: grid;
		grid-template-columns: minmax(12rem, 1fr) auto;
		gap: 0.8rem;
		align-items: end;
		margin-top: 1rem;
	}

	.workspace-facts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 1.2rem;
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
		.boundary-grid,
		.workspace-facts,
		.initialize {
			grid-template-columns: 1fr;
		}

		.heading {
			align-items: start;
			flex-direction: column;
		}

		.initialize button {
			justify-self: start;
		}
	}
</style>
