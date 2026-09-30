import { createHash } from 'node:crypto';
import type { Manifest, ManifestCatalog, MetaType, Playlist } from './types.ts';

export const ADDON_ID = 'org.imdb-playlist.stremio';
export const ADDON_VERSION = '1.0.0';
export const CATALOG_ID = 'imdb-playlist';
export const CATALOG_NAME = 'IMDB Playlist';

export interface BuildInfo {
	movieCount: number;
	seriesCount: number;
	generatedAt: string;
	buildNumber: number;
}

/**
 * Builds the manifest. Each type gets a single "IMDB Playlist" catalog, and the
 * playlist names are offered as `genre` options. Because `isRequired` is true,
 * Stremio will not open the catalog until the user picks a name.
 */
export function buildManifest(playlists: Playlist[], info: BuildInfo): Manifest {
	const catalogs: ManifestCatalog[] = [];

	for (const type of ['movie', 'series'] as MetaType[]) {
		// `genre`, not `name`: it is the exact value the catalog files are
		// written under, so the name the client reads here always resolves.
		const names = playlists
			.filter((playlist) => playlist.type === type)
			.map((playlist) => playlist.genre);

		// Declaring an empty catalog shows a blank row in Stremio.
		if (names.length === 0) continue;

		catalogs.push({
			type,
			id: CATALOG_ID,
			name: CATALOG_NAME,
			extra: [{ name: 'genre', options: names, isRequired: true }],
		});
	}

	const playlistTotal = playlists.reduce((sum, p) => sum + p.pages.reduce((n, page) => n + page.length, 0), 0);
	// Shown in Stremio as the addon's description.
	const description =
		`${info.movieCount} movie and ${info.seriesCount} series categories built from IMDb playlists. ` +
		`${playlistTotal} items in total. Updated automatically.`;

	// `types` must only list types that actually produced a catalog, otherwise
	// Stremio shows an empty "Series" tab.
	const types = catalogs.map((catalog) => catalog.type);

	return {
		id: ADDON_ID,
		version: contentVersion(playlists),
		name: CATALOG_NAME,
		description,
		types,
		resources: ['catalog'],
		catalogs,
		behaviorHints: {
			configurable: false,
			configurationRequired: false,
		},
	};
}

/**
 * Builds a version string that changes whenever the catalogs change.
 *
 * Stremio caches the manifest, and a client holding a stale copy cannot see a
 * playlist that was added since. Bumping `version` is how it notices, so the
 * string has to move whenever the set of playlists or their contents does.
 *
 * A build counter would be the obvious choice but is unusable here: the counter
 * lives in `last-build.json`, which is not committed and does not survive
 * between CI runs, so it would always report 1. Hashing the catalogue
 * signature instead gives a version that is stable across identical rebuilds
 * and differs as soon as anything real changes.
 */
function contentVersion(playlists: Playlist[]): string {
	const signature = playlists
		.map((playlist) => ({
			type: playlist.type,
			listId: playlist.listId,
			genre: playlist.genre,
			pages: playlist.pages.map((page) => page.map((meta) => `${meta.id}:${meta.type}`)),
		}))
		.sort((a, b) => a.type.localeCompare(b.type) || a.listId.localeCompare(b.listId));

	const digest = createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 12);
	return `${ADDON_VERSION}+${digest}`;
}
