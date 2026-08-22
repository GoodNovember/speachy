import { describe, expect, it } from 'vitest';
import {
	inspectWorkspaceManifest,
	WORKSPACE_KIND,
	WORKSPACE_MANIFEST_FILENAME,
	WORKSPACE_SCHEMA_VERSION,
	type WorkspaceManifestV1
} from './manifest.ts';

const validManifest: WorkspaceManifestV1 = {
	kind: WORKSPACE_KIND,
	schemaVersion: WORKSPACE_SCHEMA_VERSION,
	id: '8ab3e21e-3345-4a34-97b2-e5c59bc64a7e',
	name: 'Interview archive',
	recordingsDirectory: 'recordings',
	analysisDirectory: 'analysis/runs'
};

describe(WORKSPACE_MANIFEST_FILENAME, () => {
	it('accepts the exact portable v1 contract', () => {
		expect(inspectWorkspaceManifest(validManifest)).toEqual({
			status: 'ready',
			access: 'read-write',
			manifest: validManifest
		});
	});

	it.each([
		['absolute POSIX path', '/recordings'],
		['absolute Windows path', 'C:\\recordings'],
		['parent traversal', '../recordings'],
		['nested traversal', 'audio/../recordings'],
		['current-directory segment', './recordings'],
		['backslashes', 'audio\\recordings'],
		['trailing slash', 'recordings/']
	])('rejects an %s', (_case, recordingsDirectory) => {
		const result = inspectWorkspaceManifest({ ...validManifest, recordingsDirectory });
		expect(result.status).toBe('invalid');
	});

	it('rejects browser-local, volatile, and unknown fields without mutating the input', () => {
		const input = {
			...validManifest,
			lastOpenedAt: '2026-08-22T12:00:00Z',
			selectedFile: 'recordings/take.wav'
		};
		const snapshot = structuredClone(input);

		const result = inspectWorkspaceManifest(input);

		expect(result.status).toBe('invalid');
		expect(input).toEqual(snapshot);
	});

	it('rejects malformed identity and names instead of normalizing them', () => {
		expect(inspectWorkspaceManifest({ ...validManifest, id: 'workspace-1' }).status).toBe(
			'invalid'
		);
		expect(
			inspectWorkspaceManifest({ ...validManifest, name: '  Interview archive ' }).status
		).toBe('invalid');
	});

	it('recognizes a newer schema without interpreting or rewriting it', () => {
		const input = {
			kind: WORKSPACE_KIND,
			schemaVersion: 4,
			futureState: { storage: 'unknown-to-v1' }
		};

		expect(inspectWorkspaceManifest(input)).toEqual({
			status: 'newer-schema',
			access: 'read-only',
			schemaVersion: 4,
			raw: input
		});
	});

	it('does not mistake another JSON file for a Speachy workspace', () => {
		const result = inspectWorkspaceManifest({ ...validManifest, kind: 'another-application' });
		expect(result.status).toBe('invalid');
	});
});
