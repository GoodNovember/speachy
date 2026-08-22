import { z } from 'zod';

export const WORKSPACE_MANIFEST_FILENAME = 'speachy.workspace.json';
export const WORKSPACE_KIND = 'speachy.audio-workspace';
export const WORKSPACE_SCHEMA_VERSION = 1;

function containsNonPortablePathCharacter(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || '<>:"|?*'.includes(character);
	});
}

const portableRelativeDirectorySchema = z
	.string()
	.min(1, 'Directory path must not be empty')
	.max(240, 'Directory path must be 240 characters or fewer')
	.refine((value) => value.trim() === value, 'Directory path must not have surrounding whitespace')
	.refine((value) => !value.includes('\\'), 'Directory path must use forward slashes')
	.refine((value) => !containsNonPortablePathCharacter(value), 'Directory path is not portable')
	.refine(
		(value) =>
			!value.startsWith('/') &&
			!value.endsWith('/') &&
			value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
		'Directory path must be relative to the workspace root'
	);

export const workspaceManifestV1Schema = z.strictObject({
	kind: z.literal(WORKSPACE_KIND),
	schemaVersion: z.literal(WORKSPACE_SCHEMA_VERSION),
	id: z.uuid(),
	name: z
		.string()
		.min(1, 'Workspace name must not be empty')
		.max(120, 'Workspace name must be 120 characters or fewer')
		.refine(
			(value) => value.trim() === value,
			'Workspace name must not have surrounding whitespace'
		),
	recordingsDirectory: portableRelativeDirectorySchema,
	analysisDirectory: portableRelativeDirectorySchema
});

export type WorkspaceManifestV1 = z.infer<typeof workspaceManifestV1Schema>;

export type WorkspaceManifestInspection =
	| {
			status: 'ready';
			access: 'read-write';
			manifest: WorkspaceManifestV1;
	  }
	| {
			status: 'newer-schema';
			access: 'read-only';
			schemaVersion: number;
			raw: unknown;
	  }
	| {
			status: 'invalid';
			access: 'none';
			issues: { path: string[]; message: string }[];
	  };

const manifestEnvelopeSchema = z.looseObject({
	kind: z.literal(WORKSPACE_KIND),
	schemaVersion: z.number().int().positive()
});

function invalidInspection(error: z.ZodError): WorkspaceManifestInspection {
	return {
		status: 'invalid',
		access: 'none',
		issues: error.issues.map((issue) => ({
			path: issue.path.map(String),
			message: issue.message
		}))
	};
}

export function inspectWorkspaceManifest(input: unknown): WorkspaceManifestInspection {
	const envelope = manifestEnvelopeSchema.safeParse(input);
	if (!envelope.success) return invalidInspection(envelope.error);

	if (envelope.data.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
		return {
			status: 'newer-schema',
			access: 'read-only',
			schemaVersion: envelope.data.schemaVersion,
			raw: input
		};
	}

	const manifest = workspaceManifestV1Schema.safeParse(input);
	if (!manifest.success) return invalidInspection(manifest.error);
	return { status: 'ready', access: 'read-write', manifest: manifest.data };
}

export function inspectWorkspaceManifestText(text: string): WorkspaceManifestInspection {
	try {
		return inspectWorkspaceManifest(JSON.parse(text));
	} catch (error) {
		return {
			status: 'invalid',
			access: 'none',
			issues: [
				{
					path: [],
					message: error instanceof SyntaxError ? error.message : 'Manifest is not valid JSON'
				}
			]
		};
	}
}

export function createWorkspaceManifest(
	name: string,
	id: string = crypto.randomUUID()
): WorkspaceManifestV1 {
	return workspaceManifestV1Schema.parse({
		kind: WORKSPACE_KIND,
		schemaVersion: WORKSPACE_SCHEMA_VERSION,
		id,
		name,
		recordingsDirectory: 'recordings',
		analysisDirectory: 'analysis'
	});
}
