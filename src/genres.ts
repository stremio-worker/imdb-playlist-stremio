/**
 * TMDB genre ids → English names. These labels are rendered on catalog cards,
 * so they are kept in English for a consistent, language-neutral UI.
 */
export const MOVIE_GENRES: Record<number, string> = {
	28: 'Action',
	12: 'Adventure',
	16: 'Animation',
	35: 'Comedy',
	80: 'Crime',
	99: 'Documentary',
	18: 'Drama',
	10751: 'Family',
	14: 'Fantasy',
	36: 'History',
	27: 'Horror',
	10402: 'Music',
	9648: 'Mystery',
	10749: 'Romance',
	878: 'Science Fiction',
	10770: 'TV Movie',
	53: 'Thriller',
	10752: 'War',
	37: 'Western',
};

export const SERIES_GENRES: Record<number, string> = {
	10759: 'Action & Adventure',
	16: 'Animation',
	35: 'Comedy',
	80: 'Crime',
	99: 'Documentary',
	18: 'Drama',
	10751: 'Family',
	10762: 'Kids',
	9648: 'Mystery',
	10763: 'News',
	10764: 'Reality',
	10765: 'Sci-Fi & Fantasy',
	10766: 'Soap Opera',
	10767: 'Talk Show',
	10768: 'War & Politics',
	37: 'Western',
};

export function genreNames(genreIds: number[], type: 'movie' | 'series'): string[] {
	const table = type === 'movie' ? MOVIE_GENRES : SERIES_GENRES;
	return genreIds.map((id) => table[id]).filter((name): name is string => Boolean(name));
}