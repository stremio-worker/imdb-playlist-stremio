import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BuildConfig } from './types.ts';

const LIST_ID_RE = /^ls\d{6,}$/;

export const CONCURRENCY = 8;
export const DEFAULT_LANGUAGE = 'tr';
/** Items Stremio expects in a single page; this is the protocol default. */
const CATALOG_PAGE_SIZE = 100;

/**
 * Lists are configured comma-separated, e.g. `ls051464199,ls0123456`.
 * Whitespace is trimmed, invalid ids are dropped and repeats removed.
 */
export function parseListIds(raw: string | undefined): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(/[,\s]+/)) {
		const id = part.trim();
		if (!id) continue;
		if (!LIST_ID_RE.test(id)) {
			console.warn(`[config] skipping invalid list id: ${id}`);
			continue;
		}
		seen.add(id);
	}
	return [...seen];
}

/**
 * Reads environment variables. When a `.env` file exists it does not override
 * process.env, it only fills in variables that are missing (not needed in CI).
 */
async function loadDotEnv(file: string): Promise<void> {
	if (!existsSync(file)) return;
	const text = await readFile(file, 'utf8');
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key in process.env) continue;
		let value = trimmed.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

export async function loadConfig(rootDir: string): Promise<BuildConfig> {
	await loadDotEnv(path.join(rootDir, '.env'));

	const movieListIds = parseListIds(process.env.IMDB_MOVIE_LISTS);
	const seriesListIds = parseListIds(process.env.IMDB_SERIES_LISTS);

	if (movieListIds.length === 0 && seriesListIds.length === 0) {
		throw new Error(
			'No playlists configured. Set IMDB_MOVIE_LISTS or IMDB_SERIES_LISTS (e.g. IMDB_MOVIE_LISTS=ls051464199).',
		);
	}

	const tmdbApiKey = (process.env.TMDB_API_KEY ?? '').trim();
	if (!tmdbApiKey) {
		console.warn(
			'[config] TMDB_API_KEY is not set — all content falls back to IMDb data and descriptions stay in English.',
		);
	}

	return {
		tmdbApiKey,
		movieListIds,
		seriesListIds,
		siteDir: path.resolve(rootDir, process.env.SITE_DIR ?? 'site'),
		cacheDir: path.resolve(rootDir, process.env.CACHE_DIR ?? '.cache'),
		language: (process.env.TMDB_LANGUAGE ?? DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE,
		pageSize: positiveInt(process.env.CATALOG_PAGE_SIZE, CATALOG_PAGE_SIZE),
		concurrency: positiveInt(process.env.FETCH_CONCURRENCY, CONCURRENCY),
	};
}

/** Falls back to the default on invalid or zero values; low values stay allowed for testing. */
function positiveInt(raw: string | undefined, fallback: number): number {
	const value = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}