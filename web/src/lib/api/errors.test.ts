import { describe, expect, it } from 'vitest';
import { ApiError, parseErrorBody } from './errors.ts';

describe('parseErrorBody', () => {
	it('reads FastAPI string detail, as returned by a 404', () => {
		const error = parseErrorBody({ detail: "Model 'does-not-exist' not found" }, 404);
		expect(error).toBeInstanceOf(ApiError);
		expect(error.message).toBe("Model 'does-not-exist' not found");
		expect(error.status).toBe(404);
	});

	it('flattens FastAPI validation arrays, as returned by a 422', () => {
		const error = parseErrorBody(
			{ detail: [{ type: 'missing', loc: ['body', 'model'], msg: 'Field required' }] },
			422
		);
		expect(error.issues).toEqual([{ field: 'model', message: 'Field required' }]);
		expect(error.message).toBe('model: Field required');
	});

	it('drops only the request-part prefix from loc', () => {
		const error = parseErrorBody(
			{ detail: [{ loc: ['body', 'audio', 'format'], msg: 'bad' }] },
			422
		);
		expect(error.issues[0].field).toBe('audio.format');
	});

	it('falls back to a generic field name when loc is absent', () => {
		const error = parseErrorBody({ detail: [{ msg: 'Something is wrong' }] }, 422);
		expect(error.issues[0].field).toBe('request');
	});

	it('keeps the hint and suggestions from APIProxyError', () => {
		const error = parseErrorBody(
			{
				detail: 'Upstream failed',
				hint: 'Check your API key',
				suggested_fixes: ['Verify the key', 'Check the endpoint']
			},
			502
		);
		expect(error.hint).toBe('Check your API key');
		expect(error.suggestions).toEqual(['Verify the key', 'Check the endpoint']);
	});

	it('understands OpenAI envelopes too, for when our own server takes over', () => {
		const error = parseErrorBody(
			{ error: { message: 'Invalid model', type: 'invalid_request' } },
			400
		);
		expect(error.message).toBe('Invalid model');
	});

	it('uses a plain text body as the message', () => {
		expect(parseErrorBody('Internal Server Error', 500).message).toBe('Internal Server Error');
	});

	it('degrades gracefully on an unrecognised shape', () => {
		expect(parseErrorBody({ nope: true }, 418).message).toBe('Request failed with status 418');
	});
});
