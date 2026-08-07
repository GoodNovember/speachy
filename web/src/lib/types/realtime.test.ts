import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	isKnownServerEvent,
	parseServerEvent,
	serverEventSchema,
	SERVER_EVENT_TYPES
} from './realtime.ts';

// Validates the types against a session actually recorded from the reference,
// rather than against what the source looks like it should send.
const fixture = JSON.parse(
	await readFile(
		fileURLToPath(
			new URL('../../../tests/fixtures/python-reference/realtime-session.json', import.meta.url)
		),
		'utf8'
	)
) as { received: { event: { type: string } }[]; serverEventTypes: string[] };

describe('server events from the recorded session', () => {
	it('recorded a session that got as far as a transcription', () => {
		expect(fixture.serverEventTypes).toContain(
			'conversation.item.input_audio_transcription.completed'
		);
	});

	it('parses every event the reference actually sent', () => {
		for (const entry of fixture.received) {
			const result = serverEventSchema.safeParse(entry.event);
			expect(result.success, `${entry.event.type}: ${result.error?.message}`).toBe(true);
		}
	});

	it('recognises every recorded type as a known server event', () => {
		for (const type of fixture.serverEventTypes) {
			expect(SERVER_EVENT_TYPES as readonly string[]).toContain(type);
		}
	});

	it('keeps the Speachy-only fields on the session object', () => {
		const created = fixture.received.find((e) => e.event.type === 'session.created');
		const parsed = serverEventSchema.parse(created!.event);
		if (parsed.type !== 'session.created') throw new Error('wrong event');
		// speech_model and voice have no OpenAI equivalent.
		expect(parsed.session.speech_model).toBeTypeOf('string');
		expect(parsed.session.voice).toBeTypeOf('string');
	});

	it('reads the transcript and duration usage off the completed event', () => {
		const done = fixture.received.find(
			(e) => e.event.type === 'conversation.item.input_audio_transcription.completed'
		);
		const parsed = serverEventSchema.parse(done!.event);
		if (parsed.type !== 'conversation.item.input_audio_transcription.completed') {
			throw new Error('wrong event');
		}
		expect(parsed.transcript).toBe('Hello, world.');
		expect(parsed.usage?.type).toBe('duration');
		expect(parsed.usage?.seconds).toBeGreaterThan(0);
	});
});

describe('parseServerEvent', () => {
	it('narrows a known event', () => {
		const event = parseServerEvent({ type: 'input_audio_buffer.committed', item_id: 'item_1' });
		expect(isKnownServerEvent(event)).toBe(true);
		if (event.type === 'input_audio_buffer.committed') expect(event.item_id).toBe('item_1');
	});

	it('falls back rather than throwing on an unmodelled event type', () => {
		const event = parseServerEvent({ type: 'some.future.event', whatever: 1 });
		expect(event.type).toBe('some.future.event');
		expect(isKnownServerEvent(event)).toBe(false);
	});

	it('falls back when a known type arrives with an unexpected shape', () => {
		// Better a degraded event in the inspector than a dead socket.
		const event = parseServerEvent({ type: 'session.created' });
		expect(event.type).toBe('session.created');
	});

	it('preserves fields the schema does not model', () => {
		const event = parseServerEvent({
			type: 'input_audio_buffer.committed',
			item_id: 'item_1',
			some_future_field: 42
		}) as Record<string, unknown>;
		expect(event.some_future_field).toBe(42);
	});
});
