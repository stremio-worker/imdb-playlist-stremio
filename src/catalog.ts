import type { CatalogMeta, ImdbListItem, MetaType, TmdbMatch } from './types.ts';
import { genreNames } from './genres.ts';
import { xrdbUrl } from './tmdb.ts';

/**
 * Turns an IMDb playlist name into the `genre` value this addon publishes.
 *
 * This is the single source of truth for the name. The manifest advertises the
 * result as a `genre` option, and the catalog files are written under it, so a
 * client always asks for exactly the name that exists on disk. Deriving the two
 * separately is what caused 404s.
 *
 * A playlist name may legitimately contain a `/` ("En iyi türk dizileri/best
 * Turkish TV Series"). Percent-encoding it is not enough: the static host
 * decodes `%2F` back to `/` before it looks at the filesystem, so the request
 * would be read as a subdirectory and return 404. Substituting the separator is
 * therefore unavoidable, and doing it once here keeps every published name
 * consistent.
 *
 * Control characters carry no meaning in a list name and are dropped.
 */
export function catalogGenreName(name: string): string {
	return name.replace(/[/\\]/g, '-').replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * Every relative file path a catalog page may be requested under.
 *
 * `genre` must be the value published in the manifest, i.e. the result of
 * `catalogGenreName`. It is used verbatim here: this function only varies the
 * escaping, never the characters themselves.
 *
 * Stremio packs `extra` values into a single path segment (protocol doc:
 * `search=game%20of%20thrones&skip=100`). Client versions may use `%20` or
 * `+`, so both variants are written, plus the plain unescaped form.
 *
 * The plain form is not redundant. A static host decodes the request path
 * before it looks at the filesystem, so a request for `genre=Top%20250%20TV%20
 * Series.json` arrives looking for the file `genre=Top 250 TV Series.json` — the
 * one with literal spaces. Dropping it makes every `%20` request 404. (A
 * client that puts the raw space in the request line gets `400 Bad Request`,
 * which no file on the server can influence.)
 *
 * When `skip` is absent the first page is written, because Stremio omits
 * `skip` on the initial request.
 */
export function catalogFileNames(type: MetaType, catalogId: string, genre: string, skip: number): string[] {
	const dir = `catalog/${type}/${catalogId}`;
	const tail = skip > 0 ? `&skip=${skip}` : '';

	const encoded = encodeURIComponent(genre);
	const names = [
		`${dir}/genre=${encoded}${tail}.json`,
		`${dir}/genre=${encoded.replace(/%20/g, '+')}${tail}.json`,
		`${dir}/genre=${genre}${tail}.json`,
	];

	// Names without spaces collapse all three variants into the same file.
	return [...new Set(names)];
}

/**
 * Builds a Stremio catalog meta object. TMDB is the primary source (name,
 * description, rating, artwork); items with no TMDB counterpart fall back to
 * the data from the IMDb list.
 */
export function buildMeta(item: ImdbListItem, type: MetaType, match: TmdbMatch | null | undefined): CatalogMeta {
	const meta: CatalogMeta = {
		id: item.id,
		type,
		name: match?.title || item.originalTitleText || item.titleText || item.id,
		posterShape: 'poster',
	};

	// Artwork is rendered by XRDB. Without a TMDB match we fall back to IMDb's
	// own poster (IMDb has no backdrop equivalent).
	if (match) {
		meta.poster = xrdbUrl('poster', type, match.tmdbId);
		if (match.hasBackdrop) meta.background = xrdbUrl('backdrop', type, match.tmdbId);
	} else if (item.posterUrl) {
		meta.poster = item.posterUrl;
	}

	const description = match?.overview || item.plot;
	if (description) meta.description = description;

	const rating = match?.voteAverage ?? item.rating;
	if (typeof rating === 'number' && rating > 0) meta.imdbRating = Number(rating.toFixed(1));

	const releaseInfo = yearOf(match?.releaseDate) ?? (item.releaseYear ? String(item.releaseYear) : undefined);
	if (releaseInfo) meta.releaseInfo = releaseInfo;

	const genres = match ? genreNames(match.genreIds, type) : item.genres;
	if (genres.length) meta.genres = genres;

	return meta;
}

function yearOf(value: string | null | undefined): string | undefined {
	if (!value || value.length < 4) return undefined;
	const year = value.slice(0, 4);
	return /^\d{4}$/.test(year) ? year : undefined;
}

export function paginate(items: CatalogMeta[], size: number): CatalogMeta[][] {
	if (items.length === 0) return [[]];
	const pages: CatalogMeta[][] = [];
	for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
	return pages;
}