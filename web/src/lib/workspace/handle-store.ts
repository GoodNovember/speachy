import type { PermissionedDirectoryHandle } from './directory.ts';

const DATABASE_NAME = 'speachy-browser-state';
const DATABASE_VERSION = 1;
const HANDLE_STORE = 'workspace-handles';
const META_STORE = 'metadata';
const LAST_WORKSPACE_KEY = 'last-workspace-id';

type HandleRecord = {
	workspaceId: string;
	handle: PermissionedDirectoryHandle;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener('success', () => resolve(request.result), { once: true });
		request.addEventListener('error', () => reject(request.error), { once: true });
	});
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.addEventListener('complete', () => resolve(), { once: true });
		transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
		transaction.addEventListener('error', () => reject(transaction.error), { once: true });
	});
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
	const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
	request.addEventListener('upgradeneeded', () => {
		const database = request.result;
		if (!database.objectStoreNames.contains(HANDLE_STORE)) {
			database.createObjectStore(HANDLE_STORE, { keyPath: 'workspaceId' });
		}
		if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
	});
	return requestResult(request);
}

export async function rememberWorkspaceHandle(
	workspaceId: string,
	handle: PermissionedDirectoryHandle,
	factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<void> {
	if (factory === undefined) return;
	const database = await openDatabase(factory);
	try {
		const transaction = database.transaction([HANDLE_STORE, META_STORE], 'readwrite');
		transaction.objectStore(HANDLE_STORE).put({ workspaceId, handle } satisfies HandleRecord);
		transaction.objectStore(META_STORE).put(workspaceId, LAST_WORKSPACE_KEY);
		await transactionComplete(transaction);
	} finally {
		database.close();
	}
}

export async function loadLastWorkspaceHandle(
	factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<PermissionedDirectoryHandle | undefined> {
	if (factory === undefined) return undefined;
	const database = await openDatabase(factory);
	try {
		const metaTransaction = database.transaction(META_STORE, 'readonly');
		const workspaceId = await requestResult<string | undefined>(
			metaTransaction.objectStore(META_STORE).get(LAST_WORKSPACE_KEY)
		);
		if (workspaceId === undefined) return undefined;

		const handleTransaction = database.transaction(HANDLE_STORE, 'readonly');
		const record = await requestResult<HandleRecord | undefined>(
			handleTransaction.objectStore(HANDLE_STORE).get(workspaceId)
		);
		return record?.handle;
	} finally {
		database.close();
	}
}
