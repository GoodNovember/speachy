import type { Config } from '$lib/server/config';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			config: Config;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
