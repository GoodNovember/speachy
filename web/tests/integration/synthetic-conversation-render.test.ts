import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { float32ToPcm16Bytes, resolveFfmpegPath } from '../../src/lib/server/audio.ts';
import recipeJson from '../fixtures/evaluation/dracula-v3-synthetic-dialogue-01.json';
import {
	buildSyntheticGroundTruth,
	inspectSyntheticRecipePolicy,
	syntheticConversationRecipeV1Schema,
	type SyntheticConversationRecipeV1
} from '../helpers/evaluation-corpus.ts';

const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RECIPE_PATH = fileURLToPath(
	new URL('../fixtures/evaluation/dracula-v3-synthetic-dialogue-01.json', import.meta.url)
);
const RUN_RENDER = process.env.SPEACHY_RUN_SYNTHETIC_RENDER === '1';

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest('hex');
}

function sha256Bytes(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

async function runProcess(executable: string, args: string[]): Promise<Buffer> {
	const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	const [stdout, stderr, result] = await Promise.all([
		collect(child.stdout),
		collect(child.stderr),
		new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', (code, signal) => resolve({ code, signal }));
		})
	]);
	if (result.code !== 0) {
		throw new Error(
			`Process failed (${result.code ?? result.signal ?? 'unknown'}): ${stderr.toString('utf8')}`
		);
	}
	return stdout;
}

function wavPcm16(bytes: Uint8Array, sampleRate: number): Uint8Array {
	const output = new Uint8Array(44 + bytes.byteLength);
	const view = new DataView(output.buffer);
	const ascii = (offset: number, value: string): void => {
		for (let index = 0; index < value.length; index += 1) {
			output[offset + index] = value.charCodeAt(index);
		}
	};
	ascii(0, 'RIFF');
	view.setUint32(4, output.byteLength - 8, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, bytes.byteLength, true);
	output.set(bytes, 44);
	return output;
}

function rttm(recipe: SyntheticConversationRecipeV1): string {
	return recipe.turns
		.map((turn) => {
			const duration = turn.outputRange.end - turn.outputRange.start;
			return `SPEAKER ${recipe.id} 1 ${turn.outputRange.start.toFixed(6)} ${duration.toFixed(6)} <NA> <NA> ${turn.speakerId} <NA> <NA>`;
		})
		.join('\n');
}

async function render(
	recipe: SyntheticConversationRecipeV1,
	corpusDirectory: string,
	ffmpegPath: string
) {
	const sources = new Map(recipe.sources.map((source) => [source.id, source]));
	const speakers = new Map(recipe.speakers.map((speaker) => [speaker.id, speaker]));
	const sourceEvidence = [];
	for (const source of recipe.sources) {
		const path = join(corpusDirectory, source.audioFile);
		expect(existsSync(path), `Missing source audio: ${path}`).toBe(true);
		const digest = await sha256File(path);
		expect(digest, `Source hash changed: ${source.audioFile}`).toBe(source.audioSha256);
		sourceEvidence.push({ id: source.id, fileName: source.audioFile, sha256: digest });
	}

	const samples = new Float32Array(Math.round(recipe.render.duration * recipe.render.sampleRate));
	const clipEvidence = [];
	for (const turn of recipe.turns) {
		const source = sources.get(turn.sourceId)!;
		const speaker = speakers.get(turn.speakerId)!;
		const sourceDuration = turn.sourceRange.end - turn.sourceRange.start;
		const outputDuration = turn.outputRange.end - turn.outputRange.start;
		const pitchFactor = 2 ** (speaker.transform.pitchSemitones / 12);
		const tempo = speaker.transform.rate / pitchFactor;
		const fadeOutStart = Math.max(0, outputDuration - 0.02);
		const filter = [
			`aresample=${recipe.render.sampleRate}`,
			`asetrate=${(recipe.render.sampleRate * pitchFactor).toFixed(9)}`,
			`aresample=${recipe.render.sampleRate}`,
			`atempo=${tempo.toFixed(9)}`,
			`volume=${speaker.transform.gainDb}dB`,
			'afade=t=in:st=0:d=0.02',
			`afade=t=out:st=${fadeOutStart.toFixed(9)}:d=0.02`,
			'apad',
			`atrim=duration=${outputDuration.toFixed(9)}`,
			'asetpts=PTS-STARTPTS'
		].join(',');
		const output = await runProcess(ffmpegPath, [
			'-hide_banner',
			'-loglevel',
			'error',
			'-ss',
			String(turn.sourceRange.start),
			'-t',
			String(sourceDuration),
			'-i',
			join(corpusDirectory, source.audioFile),
			'-vn',
			'-af',
			filter,
			'-ar',
			String(recipe.render.sampleRate),
			'-ac',
			'1',
			'-f',
			'f32le',
			'pipe:1'
		]);
		expect(output.byteLength % 4).toBe(0);
		const decoded = new Float32Array(
			output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
		);
		const expectedSamples = Math.round(outputDuration * recipe.render.sampleRate);
		expect(Math.abs(decoded.length - expectedSamples)).toBeLessThanOrEqual(1);
		const outputStart = Math.round(turn.outputRange.start * recipe.render.sampleRate);
		for (let index = 0; index < Math.min(decoded.length, expectedSamples); index += 1) {
			samples[outputStart + index] += decoded[index]!;
		}
		clipEvidence.push({
			turnId: turn.id,
			sourceId: source.id,
			speakerId: speaker.id,
			filter,
			expectedSamples,
			decodedSamples: decoded.length
		});
	}

	let peak = 0;
	for (const sample of samples) {
		expect(Number.isFinite(sample)).toBe(true);
		peak = Math.max(peak, Math.abs(sample));
	}
	expect(peak, 'The fixed speaker gains should prevent overlap clipping').toBeLessThanOrEqual(1);
	const wav = wavPcm16(float32ToPcm16Bytes(samples), recipe.render.sampleRate);
	return { wav, peak, sourceEvidence, clipEvidence };
}

describe.runIf(RUN_RENDER)('synthetic conversation renderer', () => {
	it('renders deterministic six-minute two-speaker audio and exact ground truth', async () => {
		const corpusDirectory = process.env.SPEACHY_LONGFORM_CORPUS;
		expect(
			corpusDirectory,
			'SPEACHY_LONGFORM_CORPUS must point to the Dracula MP3 directory'
		).toBeTruthy();
		const recipe = syntheticConversationRecipeV1Schema.parse(recipeJson);
		expect(inspectSyntheticRecipePolicy(recipe)).toEqual([]);
		const ffmpegPath = resolveFfmpegPath();
		const ffmpegVersion = (await runProcess(ffmpegPath, ['-version']))
			.toString('utf8')
			.split(/\r?\n/, 1)[0]!;
		const rendered = await render(recipe, corpusDirectory!, ffmpegPath);
		const outputDirectory =
			process.env.SPEACHY_SYNTHETIC_OUTPUT ??
			join(WEB_ROOT, 'test-results', 'synthetic', recipe.id);
		await mkdir(outputDirectory, { recursive: true });

		const groundTruth = buildSyntheticGroundTruth(recipe);
		const recipeSha256 = await sha256File(RECIPE_PATH);
		const audioSha256 = sha256Bytes(rendered.wav);
		const truthBytes = Buffer.from(`${JSON.stringify(groundTruth, null, 2)}\n`);
		const truthSha256 = sha256Bytes(truthBytes);
		const audioPath = join(outputDirectory, `${recipe.id}.wav`);
		const truthPath = join(outputDirectory, `${recipe.id}.ground-truth.json`);
		const rttmPath = join(outputDirectory, `${recipe.id}.rttm`);
		const evidencePath = join(outputDirectory, `${recipe.id}.render-evidence.json`);
		await Promise.all([
			writeFile(audioPath, rendered.wav),
			writeFile(truthPath, truthBytes),
			writeFile(rttmPath, `${rttm(recipe)}\n`)
		]);
		const evidence = {
			kind: 'speachy.synthetic-conversation-render-evidence',
			schemaVersion: 1,
			corpusId: recipe.id,
			renderedAt: new Date().toISOString(),
			recipe: { fileName: basename(RECIPE_PATH), sha256: recipeSha256 },
			ffmpeg: { executable: basename(ffmpegPath), version: ffmpegVersion },
			audio: {
				fileName: basename(audioPath),
				sha256: audioSha256,
				byteLength: rendered.wav.byteLength,
				duration: recipe.render.duration,
				sampleRate: recipe.render.sampleRate,
				channels: recipe.render.channels,
				format: recipe.render.format,
				peak: rendered.peak
			},
			groundTruth: { fileName: basename(truthPath), sha256: truthSha256 },
			sources: rendered.sourceEvidence,
			clips: rendered.clipEvidence
		};
		await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

		expect(rendered.wav.byteLength).toBe(
			44 + recipe.render.duration * recipe.render.sampleRate * 2
		);
		expect(groundTruth.turns).toHaveLength(18);
		expect(groundTruth.overlaps).toHaveLength(9);
		expect(audioSha256).toMatch(/^[a-f0-9]{64}$/);
		console.info(
			JSON.stringify({ outputDirectory, audioSha256, truthSha256, peak: rendered.peak })
		);
	}, 300_000);
});
