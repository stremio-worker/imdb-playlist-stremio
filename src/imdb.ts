import type { ImdbList, ImdbListItem, MetaType } from './types.ts';

const API_URL = 'https://api.graphql.imdb.com/';
const PAGE_SIZE = 250;
const MAX_PAGES = 100;
const MAX_ATTEMPTS = 4;

/**
 * The IMDb GraphQL endpoint sits behind CloudFront and answers 403 without
 * browser-like headers. Requests are rejected without this set.
 */
const HEADERS: Record<string, string> = {
	'content-type': 'application/json',
	accept: 'application/json',
	'user-agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	origin: 'https://www.imdb.com',
	referer: 'https://www.imdb.com/',
	'accept-language': 'tr-TR,tr;q=0.9',
	'x-imdb-client-name': 'imdb-web-next-localized',
	'x-imdb-client-version': '1.0.0',
};

const LIST_QUERY = `
query List($id: ID!, $after: String) {
	list(id: $id) {
		id
		name { originalText }
		description { originalText { plainText } }
		titleListItemSearch(first: ${PAGE_SIZE}, after: $after) {
			total
			edges {
				title {
					id
					titleText { text }
					originalTitleText { text }
					titleType { id }
					releaseDate { year }
					primaryImage { url }
					ratingsSummary { aggregateRating }
					plot { plotText { plainText } }
					genres { genres { text } }
				}
			}
			pageInfo { hasNextPage endCursor }
		}
	}
}
`;

interface ImdbTitle {
	id: string;
	titleText?: { text?: string } | null;
	originalTitleText?: { text?: string } | null;
	titleType?: { id?: string } | null;
	releaseDate?: { year?: number | null } | null;
	primaryImage?: { url?: string | null } | null;
	ratingsSummary?: { aggregateRating?: number | null } | null;
	plot?: { plotText?: { plainText?: string | null } | null } | null;
	genres?: { genres?: Array<{ text?: string }> | null } | null;
}

interface ImdbListResponse {
	list?: {
		id?: string;
		name?: { originalText?: string } | null;
		description?: { originalText?: { plainText?: string | null } | null } | null;
		titleListItemSearch?: {
			total?: number;
			edges?: Array<{ title?: ImdbTitle | null } | null> | null;
			pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
		} | null;
	} | null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GraphQlEnvelope<T> {
	data?: T;
	errors?: Array<{ message?: string }>;
}

async function requestPage(listId: string, after: string | null): Promise<ImdbListResponse> {
	let lastError = '';

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(API_URL, {
				method: 'POST',
				headers: HEADERS,
				body: JSON.stringify({ query: LIST_QUERY, variables: { id: listId, after } }),
				signal: AbortSignal.timeout(30_000),
			});

			if (!response.ok) {
				lastError = `HTTP ${response.status}`;
				if (response.status === 400 || response.status === 401 || response.status === 403) {
					// An auth/access error will not be fixed by retrying.
					throw new Error(lastError);
				}
				throw new Error(lastError);
			}

			const envelope = (await response.json()) as GraphQlEnvelope<ImdbListResponse>;
			if (envelope.errors?.length) {
				const message = envelope.errors.map((e) => e.message ?? 'unknown').join('; ');
				// An invalid list id is a permanent error.
				throw new Error(message);
			}

			return envelope.data ?? {};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === MAX_ATTEMPTS) break;
			const backoff = 500 * 2 ** (attempt - 1);
			console.warn(`[imdb] page request for ${listId} failed (${lastError}), retrying in ${backoff}ms...`);
			await sleep(backoff);
		}
	}

	throw new Error(lastError || 'unknown error');
}

function toListItem(title: ImdbTitle): ImdbListItem | null {
	if (!title.id) return null;
	return {
		id: title.id,
		titleText: title.titleText?.text ?? '',
		originalTitleText: title.originalTitleText?.text ?? '',
		titleTypeId: title.titleType?.id ?? null,
		releaseYear: title.releaseDate?.year ?? null,
		posterUrl: title.primaryImage?.url ?? null,
		rating: title.ratingsSummary?.aggregateRating ?? null,
		plot: title.plot?.plotText?.plainText ?? null,
		genres: (title.genres?.genres ?? []).map((g) => g.text ?? '').filter(Boolean),
	};
}

/**
 * Fetches every item of a playlist via cursor pagination.
 * The list name and description come from the API too, so no name needs to be
 * configured in the environment.
 */
export async function fetchImdbList(listId: string, type: MetaType): Promise<ImdbList> {
	const first = await requestPage(listId, null);
	const list = first.list;

	if (!list) {
		throw new Error('List not found (wrong id, or it is not public)');
	}

	const items: ImdbListItem[] = [];
	for (const edge of list.titleListItemSearch?.edges ?? []) {
		if (!edge?.title) continue;
		const item = toListItem(edge.title);
		if (item) items.push(item);
	}

	let pageInfo = list.titleListItemSearch?.pageInfo;
	let pages = 1;
	while (pageInfo?.hasNextPage && pageInfo.endCursor && pages < MAX_PAGES) {
		const next = await requestPage(listId, pageInfo.endCursor);
		const search = next.list?.titleListItemSearch;
		if (!search) break;
		for (const edge of search.edges ?? []) {
			if (!edge?.title) continue;
			const item = toListItem(edge.title);
			if (item) items.push(item);
		}
		if (!search.pageInfo?.hasNextPage) break;
		pageInfo = search.pageInfo;
		pages++;
	}

	const name = list.name?.originalText?.trim();
	if (!name) throw new Error('Could not read the list name');

	const description = list.description?.originalText?.plainText?.trim() ?? null;

	console.log(`[imdb] ${listId} (${type}) "${name}" -> ${items.length} items, ${pages} page(s)`);

	return {
		listId,
		name,
		description,
		// The same IMDb id can appear more than once; drop repeats, keeping order.
		items: dedupe(items),
	};
}

function dedupe(items: ImdbListItem[]): ImdbListItem[] {
	const seen = new Set<string>();
	const out: ImdbListItem[] = [];
	for (const item of items) {
		if (seen.has(item.id)) continue;
		seen.add(item.id);
		out.push(item);
	}
	return out;
}
