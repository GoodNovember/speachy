import { describe, expect, it, vi } from 'vitest';
import {
	initializeWorkspaceDirectory,
	queryWorkspacePermission,
	readWorkspaceManifest,
	readWorkspaceManifestFromFolderFiles,
	requestWorkspacePermission,
	type PermissionedDirectoryHandle
} from './directory.ts';
import { WORKSPACE_KIND, WORKSPACE_MANIFEST_FILENAME } from './manifest.ts';

const manifestId = '8ab3e21e-3345-4a34-97b2-e5c59bc64a7e';

function textFile(contents: string, relativePath = WORKSPACE_MANIFEST_FILENAME): File {
	const file = new File([contents], WORKSPACE_MANIFEST_FILENAME, { type: 'application/json' });
	Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
	return file;
}

describe('workspace directory access', () => {
	it('distinguishes a missing manifest from other filesystem failures', async () => {
		const missing = {
			getFileHandle: vi.fn(async () => {
				throw new DOMException('missing', 'NotFoundError');
			})
		};
		await expect(readWorkspaceManifest(missing)).resolves.toEqual({ status: 'missing' });

		const denied = {
			getFileHandle: vi.fn(async () => {
				throw new DOMException('denied', 'NotAllowedError');
			})
		};
		await expect(readWorkspaceManifest(denied)).rejects.toMatchObject({ name: 'NotAllowedError' });
	});

	it('reads and validates a root manifest', async () => {
		const file = textFile(
			JSON.stringify({
				kind: WORKSPACE_KIND,
				schemaVersion: 1,
				id: manifestId,
				name: 'Interview archive',
				recordingsDirectory: 'recordings',
				analysisDirectory: 'analysis'
			})
		);
		const directory = {
			getFileHandle: vi.fn(async () => ({ getFile: async () => file }))
		};

		const result = await readWorkspaceManifest(directory as never);
		expect(result).toMatchObject({
			status: 'inspected',
			inspection: { status: 'ready', manifest: { id: manifestId } }
		});
		expect(directory.getFileHandle).toHaveBeenCalledWith(WORKSPACE_MANIFEST_FILENAME);
	});

	it('initializes only after confirming that the manifest is absent', async () => {
		let written = '';
		const close = vi.fn(async () => undefined);
		const createdDirectories: string[] = [];
		const directory = {
			name: 'Field interviews',
			getDirectoryHandle: vi.fn(async (name: string) => {
				createdDirectories.push(name);
				return directory;
			}),
			getFileHandle: vi.fn(async (_name: string, options?: { create?: boolean }) => {
				if (options?.create !== true) throw new DOMException('missing', 'NotFoundError');
				return {
					createWritable: async () => ({
						write: async (value: string) => {
							written = value;
						},
						close,
						abort: async () => undefined
					})
				};
			})
		};

		const manifest = await initializeWorkspaceDirectory(
			directory as never,
			'Field interviews',
			manifestId
		);

		expect(createdDirectories).toEqual(['recordings', 'analysis']);
		expect(JSON.parse(written)).toEqual(manifest);
		expect(written.endsWith('\n')).toBe(true);
		expect(close).toHaveBeenCalledOnce();
	});

	it('does not overwrite an existing manifest during initialization', async () => {
		const existing = textFile(
			JSON.stringify({
				kind: WORKSPACE_KIND,
				schemaVersion: 2,
				future: true
			})
		);
		const getFileHandle = vi.fn(async () => ({ getFile: async () => existing }));
		await expect(
			initializeWorkspaceDirectory({ getFileHandle } as never, 'Unsafe overwrite', manifestId)
		).rejects.toThrow('already initialized');
		expect(getFileHandle).toHaveBeenCalledOnce();
	});

	it('keeps permission query and request as separate operations', async () => {
		const handle = {
			queryPermission: vi.fn(async () => 'prompt' as const),
			requestPermission: vi.fn(async () => 'granted' as const)
		} as unknown as PermissionedDirectoryHandle;

		await expect(queryWorkspacePermission(handle)).resolves.toBe('prompt');
		expect(handle.requestPermission).not.toHaveBeenCalled();
		await expect(requestWorkspacePermission(handle)).resolves.toBe('granted');
	});

	it('finds only a root manifest in the read-only folder fallback', async () => {
		const nested = textFile('{}', `Archive/nested/${WORKSPACE_MANIFEST_FILENAME}`);
		const root = textFile(
			JSON.stringify({
				kind: WORKSPACE_KIND,
				schemaVersion: 4,
				future: true
			}),
			`Archive/${WORKSPACE_MANIFEST_FILENAME}`
		);

		const selected = readWorkspaceManifestFromFolderFiles([nested, root]);
		expect(selected.directoryName).toBe('Archive');
		await expect(selected.read).resolves.toMatchObject({
			status: 'inspected',
			inspection: { status: 'newer-schema', access: 'read-only' }
		});
	});
});
