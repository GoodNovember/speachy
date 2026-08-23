export const SUPPORTED_AUDIO_EXTENSIONS = [
	'aac',
	'flac',
	'm4a',
	'mp3',
	'mp4',
	'mpeg',
	'mpga',
	'oga',
	'ogg',
	'opus',
	'wav',
	'wave',
	'webm'
] as const;

const supportedExtensions = new Set<string>(SUPPORTED_AUDIO_EXTENSIONS);

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
	values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
};

export type WorkspaceAudioStatus =
	| { status: 'unprocessed' }
	| { status: 'ready'; analyzedAt: string }
	| { status: 'stale'; reason: string }
	| { status: 'failed'; message: string };

export type WorkspaceAudioFile = {
	relativePath: string;
	name: string;
	extension: string;
	size: number;
	lastModified: number;
	file: File;
	analysis: WorkspaceAudioStatus;
};

function comparePath(left: string, right: string): number {
	const normalizedLeft = left.toLocaleLowerCase('en-US');
	const normalizedRight = right.toLocaleLowerCase('en-US');
	if (normalizedLeft < normalizedRight) return -1;
	if (normalizedLeft > normalizedRight) return 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

function extensionOf(name: string): string | undefined {
	const separator = name.lastIndexOf('.');
	if (separator <= 0 || separator === name.length - 1) return undefined;
	return name.slice(separator + 1).toLocaleLowerCase('en-US');
}

export function isSupportedWorkspaceAudioFile(name: string): boolean {
	const extension = extensionOf(name);
	return extension !== undefined && supportedExtensions.has(extension);
}

function normalizeRelativePath(path: string): string {
	return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

function recordingPrefix(recordingsDirectory: string): string {
	return `${normalizeRelativePath(recordingsDirectory)}/`;
}

function toAudioFile(file: File, relativePath: string): WorkspaceAudioFile {
	return {
		relativePath: normalizeRelativePath(relativePath),
		name: file.name,
		extension: extensionOf(file.name)!,
		size: file.size,
		lastModified: file.lastModified,
		file,
		analysis: { status: 'unprocessed' }
	};
}

async function openRelativeDirectory(
	root: FileSystemDirectoryHandle,
	relativePath: string
): Promise<FileSystemDirectoryHandle> {
	let current = root;
	for (const segment of relativePath.split('/')) {
		current = await current.getDirectoryHandle(segment);
	}
	return current;
}

async function collectDirectoryAudio(
	directory: IterableDirectoryHandle,
	prefix: string,
	files: WorkspaceAudioFile[]
): Promise<void> {
	for await (const handle of directory.values()) {
		const relativePath = `${prefix}${handle.name}`;
		if (handle.kind === 'directory') {
			await collectDirectoryAudio(handle as IterableDirectoryHandle, `${relativePath}/`, files);
		} else if (isSupportedWorkspaceAudioFile(handle.name)) {
			files.push(toAudioFile(await handle.getFile(), relativePath));
		}
	}
}

export async function enumerateWorkspaceAudioFiles(
	root: FileSystemDirectoryHandle,
	recordingsDirectory: string
): Promise<WorkspaceAudioFile[]> {
	const directory = (await openRelativeDirectory(
		root,
		recordingsDirectory
	)) as IterableDirectoryHandle;
	const files: WorkspaceAudioFile[] = [];
	await collectDirectoryAudio(directory, recordingPrefix(recordingsDirectory), files);
	return files.sort((left, right) => comparePath(left.relativePath, right.relativePath));
}

export function enumerateWorkspaceAudioFilesFromFolderFiles(
	files: Iterable<File>,
	recordingsDirectory: string
): WorkspaceAudioFile[] {
	const prefix = recordingPrefix(recordingsDirectory);
	const selected: WorkspaceAudioFile[] = [];
	for (const file of files) {
		const parts = normalizeRelativePath(file.webkitRelativePath).split('/');
		const relativePath = parts.slice(1).join('/');
		if (!relativePath.startsWith(prefix) || !isSupportedWorkspaceAudioFile(file.name)) continue;
		selected.push(toAudioFile(file, relativePath));
	}
	return selected.sort((left, right) => comparePath(left.relativePath, right.relativePath));
}

export function reconcileWorkspaceAudioFiles(
	files: readonly WorkspaceAudioFile[],
	previous: readonly WorkspaceAudioFile[]
): WorkspaceAudioFile[] {
	const priorByPath = new Map(previous.map((file) => [file.relativePath, file]));
	return files.map((file) => {
		const prior = priorByPath.get(file.relativePath);
		if (prior === undefined || prior.analysis.status === 'unprocessed') return file;
		if (prior.size !== file.size || prior.lastModified !== file.lastModified) {
			return {
				...file,
				analysis: {
					status: 'stale',
					reason: 'The audio file changed since its analysis state was recorded.'
				}
			};
		}
		return { ...file, analysis: prior.analysis };
	});
}
