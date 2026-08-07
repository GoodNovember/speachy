import { z } from 'zod';

// The realtime event contract. Event names come from CLIENT_EVENT_TYPES and
// SERVER_EVENT_TYPES in src/speaches/types/realtime.py; payload shapes are
// taken from an observed session recorded by scripts/capture-realtime.mjs into
// tests/fixtures/python-reference/realtime-session.json.
//
// Every object is loose on purpose. The server sends fields we do not model
// yet, and dropping them would make the event inspector lie about the traffic.

export const CLIENT_EVENT_TYPES = [
	'session.update',
	'input_audio_buffer.append',
	'input_audio_buffer.commit',
	'input_audio_buffer.clear',
	'conversation.item.create',
	'conversation.item.truncate',
	'conversation.item.delete',
	'conversation.item.retrieve',
	'response.create',
	'response.cancel'
] as const;

export const SERVER_EVENT_TYPES = [
	'error',
	'session.created',
	'session.updated',
	'conversation.created',
	'input_audio_buffer.committed',
	'input_audio_buffer.cleared',
	'input_audio_buffer.speech_started',
	'input_audio_buffer.speech_stopped',
	'conversation.item.created',
	'conversation.item.added',
	'conversation.item.done',
	'conversation.item.retrieved',
	'conversation.item.input_audio_transcription.completed',
	'conversation.item.input_audio_transcription.failed',
	'conversation.item.truncated',
	'conversation.item.deleted',
	'response.created',
	'response.done',
	'response.output_item.added',
	'response.output_item.done',
	'response.content_part.added',
	'response.content_part.done',
	'response.text.delta',
	'response.text.done',
	'response.audio_transcript.delta',
	'response.audio_transcript.done',
	'response.audio.delta',
	'response.audio.done',
	'response.function_call_arguments.delta',
	'response.function_call_arguments.done',
	'rate_limits.updated'
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

// --- session -------------------------------------------------------------

export const turnDetectionSchema = z.looseObject({
	type: z.string().default('server_vad'),
	threshold: z.number().optional(),
	prefix_padding_ms: z.number().optional(),
	silence_duration_ms: z.number().optional(),
	create_response: z.boolean().optional()
});

export const inputAudioTranscriptionSchema = z.looseObject({
	model: z.string(),
	language: z.string().nullable().optional()
});

// speech_model and voice are Speachy extensions; OpenAI has no equivalent on
// the session object.
export const sessionSchema = z.looseObject({
	id: z.string(),
	model: z.string().optional(),
	modalities: z.array(z.string()).optional(),
	instructions: z.string().optional(),
	input_audio_format: z.string().optional(),
	output_audio_format: z.string().optional(),
	input_audio_transcription: inputAudioTranscriptionSchema.nullable().optional(),
	turn_detection: turnDetectionSchema.nullable().optional(),
	temperature: z.number().optional(),
	tools: z.array(z.unknown()).optional(),
	tool_choice: z.unknown().optional(),
	max_response_output_tokens: z.union([z.number(), z.string()]).optional(),
	speech_model: z.string().optional(),
	voice: z.string().optional()
});
export type Session = z.infer<typeof sessionSchema>;

// --- conversation items --------------------------------------------------

export const itemContentSchema = z.looseObject({
	type: z.string(),
	text: z.string().nullable().optional(),
	audio: z.string().nullable().optional(),
	transcript: z.string().nullable().optional()
});

export const conversationItemSchema = z.looseObject({
	id: z.string(),
	object: z.string().optional(),
	type: z.string(),
	status: z.string().optional(),
	role: z.string().optional(),
	content: z.array(itemContentSchema).optional(),
	call_id: z.string().nullable().optional(),
	name: z.string().nullable().optional(),
	arguments: z.string().nullable().optional()
});
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const realtimeErrorSchema = z.looseObject({
	type: z.string().optional(),
	code: z.string().nullable().optional(),
	message: z.string(),
	param: z.string().nullable().optional(),
	event_id: z.string().nullable().optional()
});

// --- server events -------------------------------------------------------

const base = { event_id: z.string().optional() };

export const serverEventSchema = z.discriminatedUnion('type', [
	z.looseObject({ ...base, type: z.literal('error'), error: realtimeErrorSchema }),
	z.looseObject({ ...base, type: z.literal('session.created'), session: sessionSchema }),
	z.looseObject({ ...base, type: z.literal('session.updated'), session: sessionSchema }),
	z.looseObject({ ...base, type: z.literal('conversation.created') }),

	z.looseObject({
		...base,
		type: z.literal('input_audio_buffer.committed'),
		item_id: z.string(),
		previous_item_id: z.string().nullable().optional()
	}),
	z.looseObject({ ...base, type: z.literal('input_audio_buffer.cleared') }),
	z.looseObject({
		...base,
		type: z.literal('input_audio_buffer.speech_started'),
		audio_start_ms: z.number().optional(),
		item_id: z.string().optional()
	}),
	z.looseObject({
		...base,
		type: z.literal('input_audio_buffer.speech_stopped'),
		audio_end_ms: z.number().optional(),
		item_id: z.string().optional()
	}),

	z.looseObject({
		...base,
		type: z.literal('conversation.item.created'),
		item: conversationItemSchema
	}),
	z.looseObject({
		...base,
		type: z.literal('conversation.item.added'),
		item: conversationItemSchema
	}),
	z.looseObject({
		...base,
		type: z.literal('conversation.item.done'),
		item: conversationItemSchema
	}),
	z.looseObject({
		...base,
		type: z.literal('conversation.item.retrieved'),
		item: conversationItemSchema
	}),
	z.looseObject({ ...base, type: z.literal('conversation.item.deleted'), item_id: z.string() }),
	z.looseObject({ ...base, type: z.literal('conversation.item.truncated'), item_id: z.string() }),

	z.looseObject({
		...base,
		type: z.literal('conversation.item.input_audio_transcription.completed'),
		item_id: z.string(),
		content_index: z.number().optional(),
		transcript: z.string(),
		// {"seconds": 1.41, "type": "duration"} in the observed session.
		usage: z.looseObject({ type: z.string(), seconds: z.number().optional() }).nullable().optional()
	}),
	z.looseObject({
		...base,
		type: z.literal('conversation.item.input_audio_transcription.failed'),
		item_id: z.string(),
		error: realtimeErrorSchema.optional()
	}),

	z.looseObject({ ...base, type: z.literal('response.created'), response: z.unknown() }),
	z.looseObject({ ...base, type: z.literal('response.done'), response: z.unknown() }),
	z.looseObject({
		...base,
		type: z.literal('response.output_item.added'),
		response_id: z.string().optional(),
		item: conversationItemSchema
	}),
	z.looseObject({
		...base,
		type: z.literal('response.output_item.done'),
		response_id: z.string().optional(),
		item: conversationItemSchema
	}),
	z.looseObject({ ...base, type: z.literal('response.content_part.added'), part: z.unknown() }),
	z.looseObject({ ...base, type: z.literal('response.content_part.done'), part: z.unknown() }),

	z.looseObject({
		...base,
		type: z.literal('response.text.delta'),
		item_id: z.string().optional(),
		delta: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.text.done'),
		item_id: z.string().optional(),
		text: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.audio_transcript.delta'),
		item_id: z.string().optional(),
		delta: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.audio_transcript.done'),
		item_id: z.string().optional(),
		transcript: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.audio.delta'),
		item_id: z.string().optional(),
		delta: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.audio.done'),
		item_id: z.string().optional()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.function_call_arguments.delta'),
		call_id: z.string().optional(),
		delta: z.string()
	}),
	z.looseObject({
		...base,
		type: z.literal('response.function_call_arguments.done'),
		call_id: z.string().optional(),
		name: z.string().optional(),
		arguments: z.string()
	}),

	z.looseObject({ ...base, type: z.literal('rate_limits.updated') })
]);

export type ServerEvent = z.infer<typeof serverEventSchema>;

// The server may ship event types we do not model. Falling back to a generic
// shape keeps the socket alive and the inspector honest instead of throwing.
export const unknownServerEventSchema = z.looseObject({ type: z.string() });
export type UnknownServerEvent = z.infer<typeof unknownServerEventSchema>;

export type AnyServerEvent = ServerEvent | UnknownServerEvent;

export function parseServerEvent(raw: unknown): AnyServerEvent {
	const known = serverEventSchema.safeParse(raw);
	if (known.success) return known.data;
	return unknownServerEventSchema.parse(raw);
}

export function isKnownServerEvent(event: AnyServerEvent): event is ServerEvent {
	return (SERVER_EVENT_TYPES as readonly string[]).includes(event.type);
}

// --- client events -------------------------------------------------------

export type ClientEvent =
	| { type: 'session.update'; session: Partial<Session> }
	| { type: 'input_audio_buffer.append'; audio: string }
	| { type: 'input_audio_buffer.commit' }
	| { type: 'input_audio_buffer.clear' }
	| { type: 'conversation.item.create'; item: Partial<ConversationItem> }
	| {
			type: 'conversation.item.truncate';
			item_id: string;
			content_index: number;
			audio_end_ms: number;
	  }
	| { type: 'conversation.item.delete'; item_id: string }
	| { type: 'conversation.item.retrieve'; item_id: string }
	| { type: 'response.create'; response?: Record<string, unknown> }
	| { type: 'response.cancel' };
