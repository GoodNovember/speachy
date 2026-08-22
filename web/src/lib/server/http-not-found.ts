export function apiNotFoundResponse(): Response {
	return Response.json({ detail: 'Not Found' }, { status: 404 });
}
