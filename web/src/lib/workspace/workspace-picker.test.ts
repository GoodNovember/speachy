import { describe, expect, it, vi } from 'vitest';
import type { PermissionedDirectoryHandle } from './directory.ts';
import { selectWorkspaceDirectory } from './workspace-picker.ts';

const handle = { name: 'Interview archive' } as PermissionedDirectoryHandle;

describe('workspace directory picker boundary', () => {
	it('returns the selected read-write handle', async () => {
		const picker = vi.fn(async () => handle);

		await expect(selectWorkspaceDirectory(picker)).resolves.toEqual({
			status: 'selected',
			handle
		});
		expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' });
	});

	it('distinguishes user cancellation from later workspace failures', async () => {
		const cancelled = vi.fn(async () => {
			throw new DOMException('The picker was closed', 'AbortError');
		});

		await expect(selectWorkspaceDirectory(cancelled)).resolves.toEqual({ status: 'cancelled' });
	});

	it('recognizes cross-realm AbortError-shaped picker failures', async () => {
		const cancelled = vi.fn(async () => {
			throw { name: 'AbortError' };
		});

		await expect(selectWorkspaceDirectory(cancelled)).resolves.toEqual({ status: 'cancelled' });
	});

	it('propagates non-cancellation picker errors', async () => {
		const failed = vi.fn(async () => {
			throw new Error('Picker unavailable');
		});

		await expect(selectWorkspaceDirectory(failed)).rejects.toThrow('Picker unavailable');
	});
});
