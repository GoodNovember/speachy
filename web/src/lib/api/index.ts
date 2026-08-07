import { settings } from '$lib/stores/settings.svelte';
import { SpeachyClient } from './client';

export { SpeachyClient } from './client';
export { ApiError } from './errors';

// Reads the key at call time so a change in settings takes effect immediately.
export function api(): SpeachyClient {
	return new SpeachyClient({ apiKey: settings.apiKey });
}
