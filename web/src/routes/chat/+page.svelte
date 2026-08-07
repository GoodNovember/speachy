<script lang="ts">
	import { api, ApiError } from '$lib/api';
	import type { ChatMessage } from '$lib/api/client';
	import { MicRecorder } from '$lib/audio/recorder';
	import { encodeWav } from '$lib/audio/pcm';
	import type { Model, Voice } from '$lib/types/api';

	type Turn = { role: 'user' | 'assistant'; text: string; audioUrl?: string; spoken?: boolean };

	let chatModels = $state<string[]>([]);
	let chatBaseUrl = $state('');
	let chatModel = $state('');
	let sttModels = $state<Model[]>([]);
	let sttModel = $state('');
	let speechModels = $state<Model[]>([]);
	let speechModel = $state('');
	let voices = $state<Voice[]>([]);
	let voice = $state('af_heart');
	let speakReplies = $state(true);

	let turns = $state<Turn[]>([]);
	let draft = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let setupError = $state<string | null>(null);

	let recorder: MicRecorder | undefined;
	let recording = $state(false);
	let level = $state(0);

	$effect(() => {
		void load();
	});

	$effect(() => () => {
		for (const turn of turns) if (turn.audioUrl) URL.revokeObjectURL(turn.audioUrl);
	});

	async function load(): Promise<void> {
		const client = api();
		try {
			[sttModels, speechModels, voices] = await Promise.all([
				client.listModels('automatic-speech-recognition'),
				client.listSpeechModels(),
				client.listVoices()
			]);
			if (sttModel === '' && sttModels.length > 0) sttModel = sttModels[0].id;
			if (speechModel === '' && speechModels.length > 0) speechModel = speechModels[0].id;
			if (voices.length > 0 && !voices.some((v) => (v.name ?? v.id) === voice)) {
				voice = voices[0].name ?? voices[0].id ?? '';
			}
		} catch (err) {
			setupError = message(err);
		}

		try {
			const result = await client.listChatModels();
			chatModels = result.models;
			chatBaseUrl = result.baseUrl;
			if (chatModel === '' && chatModels.length > 0) chatModel = chatModels[0];
		} catch (err) {
			setupError = message(err);
		}
	}

	const message = (err: unknown): string =>
		err instanceof ApiError || err instanceof Error ? err.message : String(err);

	function history(): ChatMessage[] {
		// Assistant turns go back as plain text. The server can resolve its own
		// audio ids from a cache, but sending text avoids depending on that.
		return turns.map((turn) => ({ role: turn.role, content: turn.text }));
	}

	async function send(content: ChatMessage['content'], displayText: string): Promise<void> {
		if (chatModel === '') return;
		busy = true;
		error = null;
		turns = [...turns, { role: 'user', text: displayText }];

		try {
			const reply = await api().chat({
				model: chatModel,
				messages: [...history().slice(0, -1), { role: 'user', content }],
				transcriptionModel: sttModel,
				voice: speakReplies ? voice : undefined,
				speechModel: speakReplies ? speechModel : undefined
			});

			turns = [
				...turns,
				{
					role: 'assistant',
					text: reply.text,
					audioUrl: reply.audio ? URL.createObjectURL(reply.audio) : undefined,
					spoken: reply.audio !== undefined
				}
			];
		} catch (err) {
			error = message(err);
		} finally {
			busy = false;
		}
	}

	async function sendText(): Promise<void> {
		const text = draft.trim();
		if (text === '') return;
		draft = '';
		await send(text, text);
	}

	async function startMic(): Promise<void> {
		error = null;
		try {
			recorder = new MicRecorder({ onLevel: (value) => (level = value) });
			await recorder.start();
			recording = true;
		} catch (err) {
			error = message(err);
			recorder = undefined;
		}
	}

	async function stopMicAndSend(): Promise<void> {
		if (recorder === undefined) return;
		const result = await recorder.stop();
		recorder = undefined;
		recording = false;
		level = 0;

		if (result.pcm.length === 0) {
			error = 'Nothing was captured.';
			return;
		}

		const wav = new Uint8Array(encodeWav(result.pcm, result.sampleRate));
		let binary = '';
		for (let i = 0; i < wav.length; i += 0x8000) {
			binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
		}

		await send(
			[{ type: 'input_audio', input_audio: { data: btoa(binary), format: 'wav' } }],
			`(spoken, ${result.durationSeconds.toFixed(1)}s)`
		);
	}

	const ready = $derived(chatModel !== '' && sttModel !== '');
</script>

<svelte:head><title>Audio chat - speachy</title></svelte:head>

<h1>Audio chat</h1>
<p>
	Speak or type; the server transcribes audio input, sends it to the chat backend, and speaks the
	reply back. Replaces the Gradio audio chat tab.
</p>

{#if setupError}<p class="error">{setupError}</p>{/if}
{#if error}<p class="error">{error}</p>{/if}

<section class="card settings">
	<div class="field">
		<label for="chat-model"
			>Chat model {#if chatBaseUrl}<span class="muted">{chatBaseUrl}</span>{/if}</label
		>
		<select id="chat-model" bind:value={chatModel} disabled={chatModels.length === 0}>
			{#each chatModels as m (m)}<option value={m}>{m}</option>{/each}
		</select>
	</div>
	<div class="field">
		<label for="stt-model">Transcription</label>
		<select id="stt-model" bind:value={sttModel}>
			{#each sttModels as m (m.id)}<option value={m.id}>{m.id}</option>{/each}
		</select>
	</div>
	<div class="field">
		<label for="voice">Voice</label>
		<select id="voice" bind:value={voice} disabled={!speakReplies}>
			{#each voices as v (v.id ?? v.name)}
				<option value={v.name ?? v.id}>{v.name ?? v.id}</option>
			{/each}
		</select>
	</div>
	<label class="check">
		<input type="checkbox" bind:checked={speakReplies} /> Speak replies
	</label>
</section>

<section class="card conversation">
	{#if turns.length === 0}
		<p class="muted">
			Nothing yet. Type a message, or hold a conversation with the microphone button.
		</p>
	{:else}
		<ol class="turns">
			{#each turns as turn, index (index)}
				<li class="turn" data-role={turn.role}>
					<span class="who">{turn.role}</span>
					<div class="body">
						<p>{turn.text}</p>
						{#if turn.audioUrl}
							<audio controls autoplay src={turn.audioUrl}></audio>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}
	{#if busy}<p class="muted">Thinking...</p>{/if}
</section>

<section class="card composer">
	<input
		placeholder="Type a message"
		bind:value={draft}
		disabled={busy || !ready}
		onkeydown={(event) => {
			if (event.key === 'Enter') void sendText();
		}}
	/>
	<button onclick={sendText} disabled={busy || !ready || draft.trim() === ''}>Send</button>
	{#if recording}
		<button onclick={stopMicAndSend}>Stop and send</button>
		<div class="meter" aria-hidden="true">
			<div class="fill" style:width="{Math.min(100, level * 300)}%"></div>
		</div>
	{:else}
		<button class="secondary" onclick={startMic} disabled={busy || !ready}>Speak</button>
	{/if}
</section>

<style>
	.settings {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.9rem;
		align-items: end;
		margin-bottom: 1rem;
	}

	.settings .muted {
		text-transform: none;
		letter-spacing: 0;
		font-family: var(--mono);
		font-size: 0.66rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin: 0 0 0.4rem;
		text-transform: none;
		letter-spacing: 0;
		font-size: 0.9rem;
		color: var(--ink-2);
	}

	.check input {
		width: auto;
	}

	.conversation {
		min-height: 10rem;
		margin-bottom: 1rem;
	}

	.turns {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.turn {
		display: grid;
		grid-template-columns: 5rem 1fr;
		gap: 0.8rem;
		align-items: baseline;
	}

	.who {
		font-family: var(--mono);
		font-size: 0.68rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.turn[data-role='assistant'] .who {
		color: var(--accent-ink);
	}

	.body :global(p) {
		margin: 0 0 0.4rem;
		color: var(--ink);
		white-space: pre-wrap;
	}

	.body audio {
		width: 100%;
		max-width: 24rem;
	}

	.composer {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.composer input {
		flex: 1;
		min-width: 12rem;
	}

	.meter {
		flex: 0 0 6rem;
		height: 0.4rem;
		background: var(--surface-2);
		border-radius: 3px;
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--accent);
		transition: width 60ms linear;
	}

	@media (max-width: 40rem) {
		.turn {
			grid-template-columns: 1fr;
			gap: 0.2rem;
		}
	}
</style>
