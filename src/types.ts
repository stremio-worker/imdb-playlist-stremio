export type MetaType = 'movie' | 'series';

/** IMDb titleType.id values, and which Stremio type each maps to. */
export const MOVIE_TITLE_TYPES = new Set(['movie', 'tvMovie', 'short', 'video', 'tvSpecial', 'documentary']);
export const SERIES_TITLE_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

export function matchesMetaType(titleTypeId: string | null, type: MetaType): boolean {
	if (!titleTypeId) return true;
	return type === 'movie' ? MOVIE_TITLE_TYPES.has(titleTypeId) : SERIES_TITLE_TYPES.has(titleTypeId);
}

export function metaTypeForTitleType(titleTypeId: string | null): MetaType | null {
	if (!titleTypeId) return null;
	if (SERIES_TITLE_TYPES.has(titleTypeId)) return 'series';
	if (MOVIE_TITLE_TYPES.has(titleTypeId)) return 'movie';
	return null;
}

/** A raw item from IMDb GraphQL, carrying every field needed to build catalog meta. */
export interface ImdbListItem {
	id: string;
	titleText: string;
	originalTitleText: string;
	titleTypeId: string | null;
	releaseYear: number | null;
	posterUrl: string | null;
	rating: number | null;
	plot: string | null;
	genres: string[];
}

export interface ImdbList {
	listId: string;
	name: string;
	description: string | null;
	items: ImdbListItem[];
}

/** A single movie or series record returned by TMDB /3/find. */
export interface TmdbMatch {
	tmdbId: number;
	title: string;
	/**
	 * XRDB returns 404 for a movie with no backdrop, so `background` is only
	 * emitted when TMDB actually has one.
	 */
	hasBackdrop: boolean;
	overview: string | null;
	voteAverage: number | null;
	releaseDate: string | null;
	genreIds: number[];
}

export interface Playlist {
	type: MetaType;
	listId: string;
	name: string;
	/** The meta list Stremio renders, already split into pages of `pageSize`. */
	pages: CatalogMeta[][];
}

export interface CatalogMeta {
	id: string;
	type: MetaType;
	name: string;
	posterShape: string;
	poster?: string;
	background?: string;
	description?: string;
	imdbRating?: number;
	releaseInfo?: string;
	genres?: string[];
}

export interface ManifestExtra {
	name: string;
	options: string[];
	isRequired?: boolean;
}

export interface ManifestCatalog {
	type: MetaType;
	id: string;
	name: string;
	extra: ManifestExtra[];
}

export interface Manifest {
	id: string;
	version: string;
	name: string;
	description: string;
	logo?: string;
	types: MetaType[];
	resources: string[];
	catalogs: ManifestCatalog[];
	behaviorHints: Record<string, boolean>;
}

export interface BuildConfig {
	tmdbApiKey: string;
	movieListIds: string[];
	seriesListIds: string[];
	siteDir: string;
	cacheDir: string;
	/** TMDB language parameter, e.g. "tr". */
	language: string;
	pageSize: number;
	concurrency: number;
}
