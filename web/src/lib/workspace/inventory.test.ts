import { describe, expect, it, vi } from 'vitest';
import {
	enumerateWorkspaceAudioFiles,
	enumerateWorkspaceAudioFilesFromFolderFiles,
	isSupportedWorkspaceAudioFile,
	reconcileWorkspaceAudioFiles,
	type WorkspaceAudioFile,
	type WorkspaceAudioStatus
} from './inventory.ts';

function audioFile(name: string, relativePath: string, options: FilePropertyBag = {}): File {
	const file = new File(['audio'], name, options);
	Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
	return file;
}

function fileHandle(file: File): FileSystemFileHandle {
	return {
		kind: 'file',
		name: file.name,
		getFile: vi.fn(async () => file)
	} as unknown as FileSystemFileHandle;
}

function directoryHandle(
	name: string,
	children: (FileSystemDirectoryHandle | FileSystemFileHandle)[] = []
): FileSystemDirectoryHandle {
	return {
		kind: 'directory',
		name,
		async *values() {
			for (const child of children) yield child;
		}
	} as unknown as FileSystemDirectoryHandle;
}

function inventoryFile(
	relativePath: string,
	lastModified: number,
	analysis: WorkspaceAudioStatus
): WorkspaceAudioFile {
	const name = relativePath.split('/').at(-1)!;
	const file = new File(['audio'], name, { lastModified });
	return {
		relativePath,
		name,
		extension: name.split('.').at(-1)!.toLowerCase(),
		size: file.size,
		lastModified,
		file,
		analysis
	};
}

describe('workspace audio inventory', () => {
	it('recognizes the explicit audio formats case-insensitively', () => {
		expect(isSupportedWorkspaceAudioFile('interview.WAV')).toBe(true);
		expect(isSupportedWorkspaceAudioFile('meeting.webm')).toBe(true);
		expect(isSupportedWorkspaceAudioFile('notes.txt')).toBe(false);
		expect(isSupportedWorkspaceAudioFile('.mp3')).toBe(false);
	});

	it('recursively enumerates supported recordings from a directory handle', async () => {
		const take = audioFile('take.WAV', 'unused');
		const nested = audioFile('answer.mp3', 'unused');
		const recordings = directoryHandle('recordings', [
			fileHandle(take),
			fileHandle(audioFile('notes.txt', 'unused')),
			directoryHandle('day-2', [fileHandle(nested)])
		]);
		const root = {
			getDirectoryHandle: vi.fn(async (name: string) => {
				expect(name).toBe('recordings');
				return recordings;
			})
		} as unknown as FileSystemDirectoryHandle;

		const result = await enumerateWorkspaceAudioFiles(root, 'recordings');

		expect(result.map((file) => file.relativePath)).toEqual([
			'recordings/day-2/answer.mp3',
			'recordings/take.WAV'
		]);
		expect(result.every((file) => file.analysis.status === 'unprocessed')).toBe(true);
	});

	it('walks nested configured recording directories one segment at a time', async () => {
		const archive = directoryHandle('archive', [fileHandle(audioFile('field.ogg', 'unused'))]);
		const audio = {
			...directoryHandle('audio'),
			getDirectoryHandle: vi.fn(async () => archive)
		} as unknown as FileSystemDirectoryHandle;
		const root = {
			getDirectoryHandle: vi.fn(async () => audio)
		} as unknown as FileSystemDirectoryHandle;

		await expect(enumerateWorkspaceAudioFiles(root, 'audio/archive')).resolves.toMatchObject([
			{ relativePath: 'audio/archive/field.ogg' }
		]);
		expect(root.getDirectoryHandle).toHaveBeenCalledWith('audio');
		expect(audio.getDirectoryHandle).toHaveBeenCalledWith('archive');
	});

	it('filters read-only folder selections to the configured recordings tree', () => {
		const result = enumerateWorkspaceAudioFilesFromFolderFiles(
			[
				audioFile('root.wav', 'Archive/root.wav'),
				audioFile('take.flac', 'Archive/recordings/day-1/take.flac'),
				audioFile('notes.json', 'Archive/recordings/notes.json'),
				audioFile('result.wav', 'Archive/analysis/result.wav')
			],
			'recordings'
		);

		expect(result.map((file) => file.relativePath)).toEqual(['recordings/day-1/take.flac']);
	});

	it('preserves analysis states across refresh and marks changed audio stale', () => {
		const ready = inventoryFile('recordings/ready.wav', 10, {
			status: 'ready',
			analyzedAt: '2026-08-22T12:00:00Z'
		});
		const failed = inventoryFile('recordings/failed.wav', 20, {
			status: 'failed',
			message: 'Inference stopped'
		});
		const changed = inventoryFile('recordings/changed.wav', 30, {
			status: 'ready',
			analyzedAt: '2026-08-22T12:00:00Z'
		});
		const refreshed = [
			inventoryFile('recordings/ready.wav', 10, { status: 'unprocessed' }),
			inventoryFile('recordings/failed.wav', 20, { status: 'unprocessed' }),
			inventoryFile('recordings/changed.wav', 31, { status: 'unprocessed' }),
			inventoryFile('recordings/new.wav', 40, { status: 'unprocessed' })
		];

		const result = reconcileWorkspaceAudioFiles(refreshed, [ready, failed, changed]);

		expect(result.map((file) => file.analysis.status)).toEqual([
			'ready',
			'failed',
			'stale',
			'unprocessed'
		]);
	});
});
