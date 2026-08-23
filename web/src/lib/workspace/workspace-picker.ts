import type { PermissionedDirectoryHandle } from './directory';

export type WorkspaceDirectoryPicker = (options: {
	mode: 'readwrite';
}) => Promise<PermissionedDirectoryHandle>;

export type WorkspaceDirectorySelection =
	{ status: 'cancelled' } | { status: 'selected'; handle: PermissionedDirectoryHandle };

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === 'AbortError') ||
		(typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
	);
}

export async function selectWorkspaceDirectory(
	picker: WorkspaceDirectoryPicker
): Promise<WorkspaceDirectorySelection> {
	try {
		return { status: 'selected', handle: await picker({ mode: 'readwrite' }) };
	} catch (error) {
		if (isAbortError(error)) return { status: 'cancelled' };
		throw error;
	}
}
