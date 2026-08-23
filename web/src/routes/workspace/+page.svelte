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
		selectWorkspaceDirectory,
		type WorkspaceDirectoryPicker
	} from '$lib/workspace/workspace-picker';
	import {
		WORKSPACE_KIND,
		WORKSPACE_MANIFEST_FILENAME,
		WORKSPACE_SCHEMA_VERSION,
		type WorkspaceManifestInspection,
		type WorkspaceManifestV1
	} from '$lib/workspace/manifest';
	import {
		enumerateWorkspaceAudioFiles,
		enumerateWorkspaceAudioFilesFromFolderFiles,
		reconcileWorkspaceAudioFiles,
		type WorkspaceAudioFile,
		type WorkspaceAudioStatus
	} from '$lib/workspace/inventory';
	import WorkspaceWaveform from '$lib/workspace/WorkspaceWaveform.svelte';
	import { WORKSPACE_TIMELINE_FIXTURE_DOCUMENT } from '$lib/workspace/timeline-fixture';

	type WorkspaceSource =
		| { kind: 'handle'; handle: PermissionedDirectoryHandle }
		| { kind: 'folder-files'; files: File[] };
	type AudioInventory =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'ready'; files: WorkspaceAudioFile[] }
		| { status: 'failed'; message: string };

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
	let workspaceSource = $state<WorkspaceSource | null>(null);
	let audioInventory = $state<AudioInventory>({ status: 'idle' });
	let selectedAudioPath = $state<string | null>(null);
	let openingPhase = $state<'idle' | 'choosing' | 'inspecting'>('idle');
	let inventoryRequest = 0;

	const selectedAudio = $derived(
		audioInventory.status === 'ready'
			? (audioInventory.files.find((file) => file.relativePath === selectedAudioPath) ?? null)
			: null
	);

	const stateLabel = $derived.by(() => {
		if (openingPhase === 'choosing') return 'Choose a directory';
		if (openingPhase === 'inspecting') return 'Opening workspace';
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

	function directoryPicker(): WorkspaceDirectoryPicker | undefined {
		const picker = (window as Window & { showDirectoryPicker?: WorkspaceDirectoryPicker })
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

	function resetInventory(): void {
		inventoryRequest += 1;
		workspaceSource = null;
		audioInventory = { status: 'idle' };
		selectedAudioPath = null;
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	}

	function formatModified(timestamp: number): string {
		return timestamp > 0 ? new Date(timestamp).toLocaleString() : 'Modification time unavailable';
	}

	function analysisLabel(analysis: WorkspaceAudioStatus): string {
		switch (analysis.status) {
			case 'ready':
				return 'Ready';
			case 'stale':
				return 'Stale';
			case 'failed':
				return 'Failed';
			default:
				return 'Unprocessed';
		}
	}

	async function refreshAudioFiles(
		manifest: WorkspaceManifestV1 | undefined = view.status === 'ready' ? view.manifest : undefined,
		source: WorkspaceSource | null = workspaceSource
	): Promise<void> {
		if (manifest === undefined || source === null) return;
		const request = ++inventoryRequest;
		const previous = audioInventory.status === 'ready' ? audioInventory.files : [];
		audioInventory = { status: 'loading' };
		try {
			const discovered =
				source.kind === 'handle'
					? await enumerateWorkspaceAudioFiles(source.handle, manifest.recordingsDirectory)
					: enumerateWorkspaceAudioFilesFromFolderFiles(source.files, manifest.recordingsDirectory);
			if (request !== inventoryRequest) return;
			const files = reconcileWorkspaceAudioFiles(discovered, previous);
			audioInventory = { status: 'ready', files };
			if (!files.some((file) => file.relativePath === selectedAudioPath)) {
				selectedAudioPath = null;
			}
		} catch (inventoryError) {
			if (request !== inventoryRequest) return;
			audioInventory = { status: 'failed', message: message(inventoryError) };
		}
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
		source?: WorkspaceSource
	): Promise<void> {
		switch (inspection.status) {
			case 'ready':
				workspaceSource = source ?? null;
				view = {
					status: 'ready',
					directoryName,
					access: source?.kind === 'handle' ? 'read-write' : 'read-only',
					manifest: inspection.manifest
				};
				if (source?.kind === 'handle') await remember(inspection.manifest, source.handle);
				await refreshAudioFiles(inspection.manifest, source ?? null);
				break;
			case 'newer-schema':
				resetInventory();
				view = { status: 'newer-schema', directoryName, schemaVersion: inspection.schemaVersion };
				break;
			case 'invalid':
				resetInventory();
				view = { status: 'invalid', directoryName, issues: inspection.issues };
				break;
		}
	}

	async function applyRead(
		read: WorkspaceManifestRead,
		directoryName: string,
		source?: WorkspaceSource
	): Promise<void> {
		if (read.status === 'missing') {
			resetInventory();
			view = {
				status: 'uninitialized',
				directoryName,
				handle: source?.kind === 'handle' ? source.handle : undefined
			};
			workspaceName = directoryName;
			return;
		}
		await applyInspection(read.inspection, directoryName, source);
	}

	async function openHandle(handle: PermissionedDirectoryHandle): Promise<void> {
		await applyRead(await readWorkspaceManifest(handle), handle.name, { kind: 'handle', handle });
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
		openingPhase = 'choosing';
		clearFeedback();
		try {
			const selection = await selectWorkspaceDirectory(picker);
			if (selection.status === 'cancelled') {
				notice = 'No directory handle was granted. Nothing was opened or changed.';
				return;
			}
			const { handle } = selection;
			openingPhase = 'inspecting';
			const permission = await queryWorkspacePermission(handle);
			if (permission !== 'granted') {
				view = { status: 'permission', handle, directoryName: handle.name };
				return;
			}
			await openHandle(handle);
		} catch (pickError) {
			error =
				openingPhase === 'choosing'
					? `The directory picker failed: ${message(pickError)}`
					: `The selected directory could not be inspected: ${message(pickError)}`;
		} finally {
			openingPhase = 'idle';
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
			workspaceSource = { kind: 'handle', handle };
			view = { status: 'ready', directoryName, access: 'read-write', manifest };
			await remember(manifest, handle);
			await refreshAudioFiles(manifest, workspaceSource);
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
			const files = [...input.files];
			const selected = readWorkspaceManifestFromFolderFiles(files);
			await applyRead(await selected.read, selected.directoryName, {
				kind: 'folder-files',
				files
			});
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
					{openingPhase === 'choosing'
						? 'Choose a folder...'
						: openingPhase === 'inspecting'
							? 'Inspecting...'
							: 'Open Audio Workspace'}
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

	<section class="card audio-library">
		<div class="library-heading">
			<div>
				<p class="step">02 / Choose a recording</p>
				<h2>Audio inventory</h2>
			</div>
			<button
				class="secondary"
				onclick={() => refreshAudioFiles()}
				disabled={audioInventory.status === 'loading'}
			>
				{audioInventory.status === 'loading' ? 'Refreshing...' : 'Refresh files'}
			</button>
		</div>

		{#if audioInventory.status === 'idle' || audioInventory.status === 'loading'}
			<p class="inventory-message" aria-live="polite">Reading supported audio files...</p>
		{:else if audioInventory.status === 'failed'}
			<div class="inventory-failure" role="alert">
				<strong>File refresh failed</strong>
				<p>{audioInventory.message}</p>
			</div>
		{:else if audioInventory.files.length === 0}
			<div class="inventory-empty">
				<strong>No supported audio found</strong>
				<p>
					Add WAV, MP3, M4A, MP4, MPEG, MPGA, OGG, Opus, FLAC, AAC, or WebM files under
					<code>{view.manifest.recordingsDirectory}/</code>, then refresh.
				</p>
			</div>
		{:else}
			<div class="audio-browser">
				<div>
					<p class="inventory-count">
						{audioInventory.files.length} recording{audioInventory.files.length === 1 ? '' : 's'}
					</p>
					<ul class="audio-list" aria-label="Workspace recordings">
						{#each audioInventory.files as audio (audio.relativePath)}
							<li>
								<button
									class:selected={selectedAudioPath === audio.relativePath}
									aria-pressed={selectedAudioPath === audio.relativePath}
									onclick={() => (selectedAudioPath = audio.relativePath)}
								>
									<span class="audio-name">{audio.name}</span>
									<span class="audio-path">{audio.relativePath}</span>
									<span class="audio-row-meta">
										<span>{formatBytes(audio.size)}</span>
										<span class="analysis-state" data-status={audio.analysis.status}>
											{analysisLabel(audio.analysis)}
										</span>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>

				<aside class="audio-selection" aria-live="polite">
					{#if selectedAudio === null}
						<p class="step">Selected file</p>
						<h3>No recording selected</h3>
						<p>Choose a recording to inspect its source identity and analysis state.</p>
					{:else}
						<p class="step">Selected file</p>
						<h3>{selectedAudio.name}</h3>
						<dl class="selection-facts">
							<div>
								<dt>Path</dt>
								<dd>{selectedAudio.relativePath}</dd>
							</div>
							<div>
								<dt>Size</dt>
								<dd>{formatBytes(selectedAudio.size)}</dd>
							</div>
							<div>
								<dt>Modified</dt>
								<dd>{formatModified(selectedAudio.lastModified)}</dd>
							</div>
							<div>
								<dt>Analysis</dt>
								<dd>{analysisLabel(selectedAudio.analysis)}</dd>
							</div>
						</dl>

						{#if selectedAudio.analysis.status === 'unprocessed'}
							<p class="analysis-copy">
								No analysis is associated with this source file yet. The fixture transcript below
								demonstrates the shared timeline geometry without claiming a completed analysis.
							</p>
						{:else if selectedAudio.analysis.status === 'ready'}
							<p class="analysis-copy">
								Analysis is current as of {selectedAudio.analysis.analyzedAt}.
							</p>
						{:else if selectedAudio.analysis.status === 'stale'}
							<p class="analysis-copy warning-copy">{selectedAudio.analysis.reason}</p>
						{:else}
							<p class="analysis-copy error-copy">{selectedAudio.analysis.message}</p>
						{/if}
					{/if}
				</aside>
			</div>
		{/if}
	</section>
	<WorkspaceWaveform
		file={selectedAudio?.file ?? null}
		annotations={WORKSPACE_TIMELINE_FIXTURE_DOCUMENT}
		annotationSource="Fixture transcript · API pending"
	/>
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

	.audio-library {
		margin-top: 1rem;
		padding: 0;
		overflow: hidden;
	}

	.library-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem 1.1rem;
		border-bottom: 1px solid var(--rule);
	}

	.library-heading h2,
	.audio-selection h3 {
		margin: 0;
	}

	.secondary {
		background: transparent;
		color: var(--accent-ink);
	}

	.inventory-message,
	.inventory-empty,
	.inventory-failure {
		margin: 0;
		padding: 1.2rem 1.1rem;
	}

	.inventory-empty p,
	.inventory-failure p {
		margin: 0.35rem 0 0;
	}

	.inventory-failure {
		border-left: 3px solid var(--danger);
		color: var(--danger);
	}

	.audio-browser {
		display: grid;
		grid-template-columns: minmax(17rem, 1fr) minmax(18rem, 0.9fr);
		min-height: 20rem;
	}

	.audio-browser > div {
		min-width: 0;
		border-right: 1px solid var(--rule);
	}

	.inventory-count {
		margin: 0;
		padding: 0.6rem 0.8rem;
		border-bottom: 1px solid var(--rule);
		font-family: var(--mono);
		font-size: 0.72rem;
		color: var(--ink-3);
	}

	.audio-list {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 27rem;
		overflow: auto;
	}

	.audio-list li + li {
		border-top: 1px solid var(--rule);
	}

	.audio-list button {
		display: grid;
		width: 100%;
		gap: 0.18rem;
		padding: 0.7rem 0.8rem;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: inherit;
		text-align: left;
	}

	.audio-list button:hover,
	.audio-list button.selected {
		background: var(--accent-wash);
	}

	.audio-list button.selected {
		box-shadow: inset 3px 0 var(--accent);
	}

	.audio-name {
		font-weight: 650;
	}

	.audio-path {
		overflow: hidden;
		font-family: var(--mono);
		font-size: 0.7rem;
		color: var(--ink-3);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.audio-row-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		font-family: var(--mono);
		font-size: 0.68rem;
		color: var(--ink-3);
	}

	.analysis-state {
		border: 1px solid var(--rule);
		border-radius: 999px;
		padding: 0.08rem 0.42rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.analysis-state[data-status='ready'] {
		border-color: var(--accent);
		color: var(--accent-ink);
	}

	.analysis-state[data-status='stale'] {
		border-style: dashed;
		color: var(--ink-2);
	}

	.analysis-state[data-status='failed'] {
		border-color: var(--danger);
		color: var(--danger);
	}

	.audio-selection {
		padding: 1rem 1.1rem;
		background: color-mix(in srgb, var(--surface), transparent 30%);
	}

	.audio-selection > p:last-child {
		margin-bottom: 0;
	}

	.selection-facts div {
		grid-template-columns: 5.2rem minmax(0, 1fr);
	}

	.analysis-copy {
		margin-top: 1rem;
		padding-top: 0.8rem;
		border-top: 1px solid var(--rule);
		font-size: 0.84rem;
	}

	.warning-copy {
		color: var(--ink-2);
	}

	.error-copy {
		color: var(--danger);
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
		.initialize,
		.audio-browser {
			grid-template-columns: 1fr;
		}

		.heading {
			align-items: start;
			flex-direction: column;
		}

		.initialize button {
			justify-self: start;
		}

		.library-heading {
			align-items: start;
			flex-direction: column;
		}

		.audio-browser > div {
			border-right: 0;
			border-bottom: 1px solid var(--rule);
		}
	}
</style>
