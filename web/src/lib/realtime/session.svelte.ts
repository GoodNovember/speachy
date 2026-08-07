import { pcm16ToBase64 } from '$lib/audio/pcm';
import { parseServerEvent, type AnyServerEvent, type ClientEvent } from '$lib/types/realtime';

export type Direction = 'in' | 'out';

export type LoggedEvent = {
	id: number;
	atMs: number;
	direction: Direction;
	type: string;
	payload: unknown;
};

export type SessionStatus = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

// Keeps the inspector bounded; a long session would otherwise grow forever.
const MAX_EVENTS = 500;

export type RealtimeSessionOptions = {
	model: string;
	intent?: 'transcription' | 'conversation';
	language?: string;
};

export class RealtimeSession {
	status = $state<SessionStatus>('idle');
	sessionId = $state<string | null>(null);
	error = $state<string | null>(null);
	events = $state<LoggedEvent[]>([]);
	transcripts = $state<string[]>([]);
	speaking = $state(false);
	audioChunksSent = $state(0);

	#socket: WebSocket | undefined;
	#nextId = 1;
	#startedAt = 0;

	get isOpen(): boolean {
		return this.status === 'open';
	}

	connect(options: RealtimeSessionOptions): void {
		this.disconnect();

		this.status = 'connecting';
		this.error = null;
		this.events = [];
		this.transcripts = [];
		this.audioChunksSent = 0;
		this.sessionId = null;
		this.#startedAt = performance.now();

		const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const query = [
			`model=${encodeURIComponent(options.model)}`,
			`intent=${encodeURIComponent(options.intent ?? 'transcription')}`
		];
		if (options.language) query.push(`language=${encodeURIComponent(options.language)}`);

		const socket = new WebSocket(
			`${scheme}//${window.location.host}/v1/realtime?${query.join('&')}`
		);
		this.#socket = socket;

		socket.addEventListener('open', () => {
			this.status = 'open';
		});

		socket.addEventListener('message', (message) => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(message.data));
			} catch {
				this.#log('in', 'malformed', { raw: String(message.data).slice(0, 200) });
				return;
			}
			const event = parseServerEvent(raw);
			this.#log('in', event.type, event);
			this.#apply(event);
		});

		socket.addEventListener('error', () => {
			this.status = 'error';
			this.error = 'WebSocket error. Is the reference server running?';
		});

		socket.addEventListener('close', (event) => {
			if (this.status !== 'error') this.status = 'closed';
			if (event.reason) this.error ??= event.reason;
			this.#socket = undefined;
		});
	}

	disconnect(): void {
		this.#socket?.close();
		this.#socket = undefined;
	}

	send(event: ClientEvent): void {
		if (this.#socket === undefined || this.#socket.readyState !== WebSocket.OPEN) return;
		this.#socket.send(JSON.stringify(event));

		// Audio frames arrive many times a second and each carries a large base64
		// payload; logging them whole would drown the inspector.
		if (event.type === 'input_audio_buffer.append') {
			this.audioChunksSent += 1;
			this.#log('out', event.type, { audio: `<${event.audio.length} base64 chars>` });
			return;
		}
		this.#log('out', event.type, event);
	}

	sendAudio(pcm: Int16Array): void {
		this.send({ type: 'input_audio_buffer.append', audio: pcm16ToBase64(pcm) });
	}

	commit(): void {
		this.send({ type: 'input_audio_buffer.commit' });
	}

	clearBuffer(): void {
		this.send({ type: 'input_audio_buffer.clear' });
	}

	#log(direction: Direction, type: string, payload: unknown): void {
		const entry: LoggedEvent = {
			id: this.#nextId++,
			atMs: Math.round(performance.now() - this.#startedAt),
			direction,
			type,
			payload
		};
		const next = [...this.events, entry];
		this.events = next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
	}

	#apply(event: AnyServerEvent): void {
		switch (event.type) {
			case 'session.created':
			case 'session.updated': {
				const session = (event as { session?: { id?: string } }).session;
				if (session?.id !== undefined) this.sessionId = session.id;
				break;
			}
			case 'input_audio_buffer.speech_started':
				this.speaking = true;
				break;
			case 'input_audio_buffer.speech_stopped':
				this.speaking = false;
				break;
			case 'conversation.item.input_audio_transcription.completed': {
				const transcript = (event as { transcript?: string }).transcript;
				if (transcript !== undefined && transcript.trim() !== '') {
					this.transcripts = [...this.transcripts, transcript.trim()];
				}
				break;
			}
			case 'error': {
				const message = (event as { error?: { message?: string } }).error?.message;
				this.error = message ?? 'Unknown error';
				break;
			}
		}
	}
}
