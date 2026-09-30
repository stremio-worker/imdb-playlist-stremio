import path from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig, writeJson, ensureDir } from './config.ts';
import { fetchImdbList } from './imdb.ts';
import { TmdbCache, enrichItems, defaultCacheFile, FatalError } from './tmdb.ts';
import { buildMeta, catalogFileNames, paginate } from './catalog.ts';
import { buildManifest, CATALOG_ID, type BuildInfo } from './manifest.ts';
import type { CatalogMeta, ImdbList, ImdbListItem, MetaType, Playlist } from './types.ts';
import { matchesMetaType, metaTypeForTitleType } from './types.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

// Client-side cache directives: 6 hours, 7 days on error.
const CACHE_MAX_AGE = 21600;
const STALE_ERROR = 604800;

interface PreviousBuild {
	buildNumber: number;
	generatedAt: string;
	playlists: Array<{ type: MetaType; listId: string; name: string; count: number }>;
}

/**
 * Matches a playlist's items against the selected type. Items whose IMDb
 * `titleType` contradicts the list type are dropped; unknown types (custom
 * shorts, episodes) are kept as-is.
 */
function selectItems(list: ImdbList, type: MetaType): { kept: ImdbListItem[]; dropped: number } {
	const kept: ImdbListItem[] = [];
	let dropped = 0;

	for (const item of list.items) {
		const derived = metaTypeForTitleType(item.titleTypeId);
		if (derived && derived !== type) {
			dropped++;
			continue;
		}
		if (!matchesMetaType(item.titleTypeId, type)) {
			dropped++;
			continue;
		}
		kept.push(item);
	}

	return { kept, dropped };
}

async function readPreviousBuild(): Promise<PreviousBuild | null> {
	const file = path.join(ROOT_DIR, 'last-build.json');
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(await readFile(file, 'utf8')) as PreviousBuild;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const started = Date.now();
	const config = await loadConfig(ROOT_DIR);

	console.log('='.repeat(60));
	console.log('IMDB Playlist → Stremio static build');
	console.log('='.repeat(60));
	console.log(`Movie lists : ${config.movieListIds.length}`);
	console.log(`Series lists: ${config.seriesListIds.length}`);
	console.log(`TMDB key    : ${config.tmdbApiKey ? 'present' : 'MISSING (will fall back to IMDb data)'}`);
	console.log('');

	// Wipe the output directory so deleted playlists never leave stale files behind.
	await rm(config.siteDir, { recursive: true, force: true });
	await ensureDir(config.siteDir);

	const cache = new TmdbCache(defaultCacheFile(config.cacheDir));
	await ensureDir(config.cacheDir);
	await cache.load();

	const playlists: Playlist[] = [];
	const usedNames = new Map<MetaType, Set<string>>([
		['movie', new Set<string>()],
		['series', new Set<string>()],
	]);
	const totalTmdbHits = { count: 0 };
	const totalItems = { count: 0 };

	const tasks: Array<{ type: MetaType; listId: string }> = [
		...config.movieListIds.map((listId) => ({ type: 'movie' as const, listId })),
		...config.seriesListIds.map((listId) => ({ type: 'series' as const, listId })),
	];

	for (const task of tasks) {
		const { type, listId } = task;

		let list: ImdbList;
		try {
			list = await fetchImdbList(listId, type);
		} catch (error) {
			// A single failing list must not abort the build; the rest still ship.
			console.warn(`[build] skipping ${listId}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}

		const names = usedNames.get(type) as Set<string>;
		if (names.has(list.name)) {
			console.warn(
				`[build] skipping ${listId}: a playlist named "${list.name}" (${type}) already exists — ` +
					'two playlists with the same name cannot be told apart by the user.',
			);
			continue;
		}

		const { kept, dropped } = selectItems(list, type);
		if (dropped) {
			console.log(`[build] ${listId}: kept ${kept.length}, dropped ${dropped} whose title type contradicts ${type}`);
		}
		if (kept.length === 0) {
			console.warn(`[build] ${listId} ("${list.name}") contains no ${type} items; not added as a catalog.`);
			continue;
		}

		const matches = config.tmdbApiKey
			? await enrichItems(
					kept,
					type,
					{ apiKey: config.tmdbApiKey, language: config.language, cache },
					config.concurrency,
				)
			: new Map();

		const metas: CatalogMeta[] = kept.map((item) => {
			const match = matches.get(item.id) ?? null;
			if (match) totalTmdbHits.count++;
			return buildMeta(item, type, match);
		});

		names.add(list.name);
		playlists.push({ type, listId, name: list.name, pages: paginate(metas, config.pageSize) });
		totalItems.count += metas.length;

		console.log(
			`[build] ✓ "${list.name}" (${type}) — ${metas.length} items, ` +
				`${metas.length > config.pageSize ? Math.ceil(metas.length / config.pageSize) : 1} page(s), ` +
				`TMDB matched ${matches.size}/${metas.length}`,
		);
	}

	if (playlists.length === 0) {
		throw new Error('No playlist could be built. Check the list ids and IMDb reachability.');
	}

	// Static catalog files.
	let fileCount = 0;
	for (const playlist of playlists) {
		for (let pageIndex = 0; pageIndex < playlist.pages.length; pageIndex++) {
			const page = playlist.pages[pageIndex] as CatalogMeta[];
			const skip = pageIndex * config.pageSize;
			for (const fileName of catalogFileNames(playlist.type, CATALOG_ID, playlist.name, skip)) {
				await writeJson(path.join(config.siteDir, fileName), {
					metas: page,
					// Stremio clients can read cache directives from the response body.
					cacheMaxAge: CACHE_MAX_AGE,
					staleRevalidate: CACHE_MAX_AGE,
					staleError: STALE_ERROR,
				});
				fileCount++;
			}
		}
	}

	// Previous build info (for incrementing the build number).
	const previous = await readPreviousBuild();
	const info: BuildInfo = {
		movieCount: playlists.filter((p) => p.type === 'movie').length,
		seriesCount: playlists.filter((p) => p.type === 'series').length,
		generatedAt: new Date().toISOString(),
		buildNumber: (previous?.buildNumber ?? 0) + 1,
	};

	const manifest = buildManifest(playlists, info);
	await writeJson(path.join(config.siteDir, 'manifest.json'), manifest);
	fileCount++;

	// Human-readable build summary.
	await writeJson(path.join(config.siteDir, 'build-info.json'), {
		...info,
		version: manifest.version,
		addonUrlPlaceholder: 'https://<user>.github.io/imdb-playlist-stremio/manifest.json',
		playlists: playlists.map((p) => ({
			type: p.type,
			listId: p.listId,
			name: p.name,
			itemCount: p.pages.reduce((n, page) => n + page.length, 0),
			pageCount: p.pages.length,
		})),
	});

	await cache.save();
	await writeFile(
		path.join(ROOT_DIR, 'last-build.json'),
		`${JSON.stringify(
			{
				buildNumber: info.buildNumber,
				generatedAt: info.generatedAt,
				playlists: playlists.map((p) => ({
					type: p.type,
					listId: p.listId,
					name: p.name,
					count: p.pages.reduce((n, page) => n + page.length, 0),
				})),
			} satisfies PreviousBuild,
			null,
			2,
		)}\n`,
		'utf8',
	);

	// Stremio requests /favicon while loading; an empty file answers it quietly.
	await writeFile(path.join(config.siteDir, 'favicon.ico'), Buffer.alloc(0));

	console.log('');
	console.log('-'.repeat(60));
	console.log(`Done: ${playlists.length} playlists, ${totalItems.count} items, ${fileCount} files`);
	console.log(`TMDB matched: ${totalTmdbHits.count}/${totalItems.count} (${pct(totalTmdbHits.count, totalItems.count)}%)`);
	console.log(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
	console.log(`Build #${info.buildNumber} → ${config.siteDir}`);
	console.log('-'.repeat(60));
}

function pct(part: number, whole: number): string {
	return whole === 0 ? '0' : ((part / whole) * 100).toFixed(1);
}

main().catch((error: unknown) => {
	if (error instanceof FatalError) console.error(`[build] FATAL: ${error.message}`);
	else console.error(`[build] ERROR: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});