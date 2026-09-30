import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ImdbListItem, MetaType, TmdbMatch } from './types.ts';

const API_BASE = 'https://api.themoviedb.org/3';
const MAX_ATTEMPTS = 4;
const CACHE_VERSION = 1;

const XRDB_BASE = 'https://extendedratings.com';
const XRDB_KEY = 'extendedratings';

/**
 * XRDB renders artwork from a TMDB id and overlays an age/violence badge, a
 * rating ring and the genre in the requested language. It looks markedly
 * richer than a plain `image.tmdb.org` poster.
 */
const XRDB_CONFIG = encodeURIComponent(
	JSON.stringify({
		size: 'normal',
		outputFormat: 'jpeg',
		outputQuality: 40,
		artworkSource: 'omdb',
		language: 'tr',
		ratings: ['imdb', 'tmdb'],
		ageRating: true,
		releaseStatusPos: 'tl',
		ageRatingPos: 'tr',
		genre: true,
		genrePos: 'tc',
		trendingStyle: 'word',
		ratingRing: true,
		ratingRingPos: 'tl',
		fallbackLanguage: 'en',
	}),
);

export function xrdbUrl(surface: 'poster' | 'backdrop', type: MetaType, tmdbId: number): string {
	return `${XRDB_BASE}/${surface}/${type}:${tmdbId}?config=${XRDB_CONFIG}&key=${XRDB_KEY}`;
}

interface FindResult {
	movie_results?: TmdbRaw[];
	tv_results?: TmdbRaw[];
	status_code?: number;
	status_message?: string;
}

interface TmdbRaw {
	id: number;
	title?: string;
	name?: string;
	backdrop_path?: string | null;
	overview?: string | null;
	vote_average?: number | null;
	release_date?: string | null;
	first_air_date?: string | null;
	genre_ids?: number[];
}

type CacheShape = Record<string, TmdbMatch | null>;

/** On-disk cache so items that do not change between builds are not re-fetched. */
export class TmdbCache {
	private data: CacheShape = {};
	private dirty = false;

	constructor(private readonly file: string) {}

	async load(): Promise<void> {
		try {
			const text = await readFile(this.file, 'utf8');
			const parsed = JSON.parse(text) as { version?: number; entries?: CacheShape };
			if (parsed.version === CACHE_VERSION && parsed.entries) this.data = parsed.entries;
			else console.log('[tmdb] cache version differs, resetting');
		} catch {
			// First run, or a corrupt cache — not an error.
		}
		const count = Object.keys(this.data).length;
		if (count) console.log(`[tmdb] loaded ${count} items from cache`);
	}

	get(imdbId: string): TmdbMatch | null | undefined {
		return this.data[imdbId];
	}

	set(imdbId: string, value: TmdbMatch | null): void {
		this.data[imdbId] = value;
		this.dirty = true;
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		await writeFile(this.file, `${JSON.stringify({ version: CACHE_VERSION, entries: this.data })}\n`, 'utf8');
		this.dirty = false;
	}

	get size(): number {
		return Object.keys(this.data).length;
	}
}

export interface TmdbClientOptions {
	apiKey: string;
	language: string;
	cache: TmdbCache;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Finds the TMDB record for an IMDb id. When `type` is given, only a result of
 * that type is accepted, so an item contradicting its list type gets dropped.
 */
export async function findByImdbId(
	imdbId: string,
	type: MetaType,
	options: TmdbClientOptions,
): Promise<TmdbMatch | null> {
	const cached = options.cache.get(imdbId);
	if (cached !== undefined) return cached;

	const url =
		`${API_BASE}/find/${encodeURIComponent(imdbId)}` +
		`?external_source=imdb_id&language=${encodeURIComponent(options.language)}&api_key=${encodeURIComponent(options.apiKey)}`;

	let lastError = '';
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(20_000),
			});

			if (response.status === 401) {
				throw new FatalError('TMDB_API_KEY is invalid (401). Check the key.');
			}
			if (response.status === 429) {
				lastError = 'HTTP 429 (rate limit)';
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			const data = (await response.json()) as FindResult;
			const pool = type === 'movie' ? (data.movie_results ?? []) : (data.tv_results ?? []);
			const raw = pool[0];

			const match: TmdbMatch | null = raw
				? {
						tmdbId: raw.id,
						title: (type === 'movie' ? raw.title : raw.name) ?? '',
						hasBackdrop: Boolean(raw.backdrop_path),
						overview: raw.overview ?? null,
						voteAverage: typeof raw.vote_average === 'number' ? raw.vote_average : null,
						releaseDate: (type === 'movie' ? raw.release_date : raw.first_air_date) ?? null,
						genreIds: raw.genre_ids ?? [],
					}
				: null;

			options.cache.set(imdbId, match);
			return match;
		} catch (error) {
			if (error instanceof FatalError) throw error;
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === MAX_ATTEMPTS) break;
			const backoff = 500 * 2 ** (attempt - 1);
			console.warn(`[tmdb] request for ${imdbId} failed (${lastError}), retrying in ${backoff}ms...`);
			await sleep(backoff);
		}
	}

	throw new Error(lastError || 'unknown error');
}

export class FatalError extends Error {}

/**
 * Enriches playlist items from TMDB. Items with no TMDB counterpart stay null;
 * the caller falls back to IMDb data for those.
 */
export async function enrichItems(
	items: ImdbListItem[],
	type: MetaType,
	options: TmdbClientOptions,
	concurrency: number,
): Promise<Map<string, TmdbMatch>> {
	const hits = new Map<string, TmdbMatch>();
	const pending: ImdbListItem[] = [];
	let cacheHits = 0;

	for (const item of items) {
		const cached = options.cache.get(item.id);
		if (cached === undefined) pending.push(item);
		else if (cached) hits.set(item.id, cached);
		else cacheHits++;
	}

	if (cacheHits) console.log(`[tmdb] ${cacheHits} items served from cache, ${pending.length} to fetch`);

	let done = 0;
	const results = await runPool(pending, concurrency, async (item) => {
		const match = await findByImdbId(item.id, type, options);
		done++;
		if (done % 50 === 0) console.log(`[tmdb] fetched ${done}/${pending.length} items`);
		return match;
	});

	results.forEach((match, index) => {
		const item = pending[index];
		if (item && match) hits.set(item.id, match);
	});

	return hits;
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export function defaultCacheFile(cacheDir: string): string {
	return path.join(cacheDir, 'tmdb-cache.json');
}
