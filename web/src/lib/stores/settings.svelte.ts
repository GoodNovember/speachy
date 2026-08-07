// Same storage key the Gradio playground used, so an existing key carries over.
const API_KEY_STORAGE = 'speaches_api_key';

function read(key: string): string {
	if (typeof localStorage === 'undefined') return '';
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

function write(key: string, value: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (value === '') localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// storage disabled; keep working in memory
	}
}

class Settings {
	#apiKey = $state(read(API_KEY_STORAGE));

	get apiKey(): string {
		return this.#apiKey;
	}

	set apiKey(value: string) {
		this.#apiKey = value;
		write(API_KEY_STORAGE, value);
	}
}

export const settings = new Settings();
