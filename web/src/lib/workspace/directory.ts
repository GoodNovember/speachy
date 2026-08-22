import {
	createWorkspaceManifest,
	inspectWorkspaceManifestText,
	WORKSPACE_MANIFEST_FILENAME,
	type WorkspaceManifestInspection,
	type WorkspaceManifestV1
} from './manifest.ts';

export type PermissionedDirectoryHandle = FileSystemDirectoryHandle & {
	queryPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
	requestPermission(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
};

export type WorkspaceManifestRead =
	{ status: 'missing' } | { status: 'inspected'; inspection: WorkspaceManifestInspection };

function isNotFoundError(error: unknown): boolean {
	return error instanceof DOMException
		? error.name === 'NotFoundError'
		: typeof error === 'object' &&
				error !== null &&
				'name' in error &&
				error.name === 'NotFoundError';
}

export async function readWorkspaceManifest(
	directory: Pick<FileSystemDirectoryHandle, 'getFileHandle'>
): Promise<WorkspaceManifestRead> {
	let fileHandle: FileSystemFileHandle;
	try {
		fileHandle = await directory.getFileHandle(WORKSPACE_MANIFEST_FILENAME);
	} catch (error) {
		if (isNotFoundError(error)) return { status: 'missing' };
		throw error;
	}

	const file = await fileHandle.getFile();
	return { status: 'inspected', inspection: inspectWorkspaceManifestText(await file.text()) };
}

async function ensureRelativeDirectory(
	root: FileSystemDirectoryHandle,
	relativePath: string
): Promise<void> {
	let current = root;
	for (const segment of relativePath.split('/')) {
		current = await current.getDirectoryHandle(segment, { create: true });
	}
}

export async function initializeWorkspaceDirectory(
	directory: FileSystemDirectoryHandle,
	name: string,
	id?: string
): Promise<WorkspaceManifestV1> {
	const existing = await readWorkspaceManifest(directory);
	if (existing.status !== 'missing') throw new Error('This directory is already initialized');

	const manifest = createWorkspaceManifest(name, id);
	await ensureRelativeDirectory(directory, manifest.recordingsDirectory);
	await ensureRelativeDirectory(directory, manifest.analysisDirectory);

	const manifestHandle = await directory.getFileHandle(WORKSPACE_MANIFEST_FILENAME, {
		create: true
	});
	const writable = await manifestHandle.createWritable();
	try {
		await writable.write(`${JSON.stringify(manifest, null, 2)}\n`);
		await writable.close();
	} catch (error) {
		await writable.abort(error).catch(() => undefined);
		throw error;
	}

	return manifest;
}

export async function queryWorkspacePermission(
	handle: PermissionedDirectoryHandle
): Promise<PermissionState> {
	return handle.queryPermission({ mode: 'readwrite' });
}

export async function requestWorkspacePermission(
	handle: PermissionedDirectoryHandle
): Promise<PermissionState> {
	return handle.requestPermission({ mode: 'readwrite' });
}

export function readWorkspaceManifestFromFolderFiles(files: Iterable<File>): {
	directoryName: string;
	read: Promise<WorkspaceManifestRead>;
} {
	const selected = [...files];
	const firstPath = selected[0]?.webkitRelativePath;
	const directoryName = firstPath?.split('/')[0] || 'Selected folder';
	const manifest = selected.find((file) => {
		const parts = file.webkitRelativePath.split('/');
		return parts.length === 2 && parts[1] === WORKSPACE_MANIFEST_FILENAME;
	});

	return {
		directoryName,
		read:
			manifest === undefined
				? Promise.resolve({ status: 'missing' })
				: manifest.text().then((text) => ({
						status: 'inspected' as const,
						inspection: inspectWorkspaceManifestText(text)
					}))
	};
}
