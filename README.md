# IMDB Playlist → Stremio

A fully static Stremio addon that turns IMDb playlists into catalogs, built and
served from GitHub Pages.

**Live addon:**
```
https://stremio-worker.github.io/imdb-playlist-stremio/manifest.json
```

It exposes a separate "IMDB Playlist" category for movies and for series. Each
playlist's **name** is offered as a `genre` option, so the user picks a name and
lands on that playlist's contents. Playlist names are not configured anywhere:
they are read straight from the IMDb API.

> Two playlists are configured right now: the movie list `ls051464199`
> (Yeşilçam, 25 films) and the series list `ls008957859` (Top 250 TV Series, 250
> shows). See [Adding or removing lists](#adding-or-removing-lists) to change
> them.

## How it works

```
IMDb GraphQL                     TMDB
  list name + tt… ids        →   /3/find?external_source=imdb_id
                                 (localised title, overview, rating)
                     ↓
         static JSON files under site/
                     ↓
               GitHub Pages (gh-pages)
```

The API key is only read inside CI; it never ends up in any generated file.
Content comes from two sources:

| Field | Primary | Fallback |
| --- | --- | --- |
| `name` | TMDB (in `TMDB_LANGUAGE`) | IMDb `originalTitleText` |
| `poster` | XRDB (with overlays) | IMDb `primaryImage` |
| `background` | XRDB (with overlays) | — |
| `description` | TMDB `overview` (in `TMDB_LANGUAGE`) | IMDb `plot` |
| `imdbRating` | TMDB `vote_average` | IMDb `aggregateRating` |
| `genres` | TMDB `genre_ids` → English names | IMDb `genres` |

Artwork is not served from the TMDB CDN directly. It is rendered by
[extendedratings.com](https://extendedratings.com), which overlays an age/violence
badge, a rating ring and the genre. XRDB works from a TMDB id, so
these fields apply to items that matched on TMDB; without a match the item
falls back to IMDb's own poster. No `background` is emitted for titles that have
no backdrop on TMDB, because XRDB returns 404 in that case.

Items are published with `tt…` ids. That lets Stremio resolve a card's metadata
through its own Cinemeta addon, so this addon does not need to serve a `meta`
resource. `resources` contains only `catalog`.

Catalog responses also carry `cacheMaxAge`, `staleRevalidate` and `staleError`
(6 hours / 6 hours / 7 days).

## Setup

### 1. Configure the repo and Pages

Under **Settings → Pages → Build and deployment → Source**, set it to
`Deploy from a branch` with branch `gh-pages`.

> Note: on the free plan, GitHub Pages only works for **public** repositories.

### 2. Define the variables

Under **Settings → Secrets and variables → Actions**:

Secret:

| Name | Description |
| --- | --- |
| `TMDB_API_KEY` | [TMDB API key](https://www.themoviedb.org/settings/api) |

Variables:

| Name | Example | Description |
| --- | --- | --- |
| `IMDB_MOVIE_LISTS` | `ls051464199` | Comma-separated movie playlists |
| `IMDB_SERIES_LISTS` | `ls008957859` | Comma-separated series playlists |

You do not need to supply a playlist name. The `ls051464199` part of
`https://www.imdb.com/list/ls051464199/` is enough. Only public lists work.

## Adding or removing lists

This is the part you will repeat most often. You never edit any file — the
playlists live entirely in two repository variables.

**1. Find the list id on IMDb.** Open the list in a browser; the id is the
`ls…` segment of the URL:

```
https://www.imdb.com/list/ls051464199/     ->  ls051464199
```

The list must be public. Private or non-existent ids come back as
`FORBIDDEN` / `RESOURCE_NOT_FOUND` and are skipped. Copy the `ls…` part, not the
whole URL.

Three real ids you can try, all verified against the IMDb API:

| Id | Name | Items | Type |
| --- | --- | --- | --- |
| `ls051464199` | Yeşilçam | 25 | movie |
| `ls0022802` | The great expectations & much greater disappointments | 15 | movie |
| `ls008957859` | Top 250 TV Series | 250 | series |

**2. Put the id in the right variable.** Movies go in `IMDB_MOVIE_LISTS`, series
in `IMDB_SERIES_LISTS`. Separate several ids with commas. Whitespace around the
commas is fine.

| On IMDb this list is… | Variable |
| --- | --- |
| movies | `IMDB_MOVIE_LISTS` |
| series | `IMDB_SERIES_LISTS` |

```bash
gh variable set IMDB_MOVIE_LISTS \
  --repo stremio-worker/imdb-playlist-stremio --body 'ls051464199,ls0022802'
gh variable set IMDB_SERIES_LISTS \
  --repo stremio-worker/imdb-playlist-stremio --body 'ls008957859'
```

Via the web UI: **Settings → Secrets and variables → Actions → Variables tab →
edit the variable → type the new ids → Update variable.**

To remove every list of one type, delete the variable:

```bash
gh variable delete IMDB_SERIES_LISTS --repo stremio-worker/imdb-playlist-stremio
```

Note that `gh variable set … --body ''` does **not** work — the GitHub API
rejects an empty value. Delete the variable instead.

**3. Rebuild.** Changing a variable does not trigger anything on its own, so
trigger the workflow:

```bash
gh workflow run build.yml --repo stremio-worker/imdb-playlist-stremio
```

Or use **Actions → Build & Deploy → Run workflow** in the repo UI. The new
category appears in Stremio after the next successful run, usually within a
minute. Removing an id has the same effect: its category disappears.

### Why the version number matters

Stremio caches the manifest, and a client holding a stale copy cannot see a
playlist that was added since. Bumping `version` is how the client notices, so
the manifest version **must** change whenever the catalogs do.

The manifest carries a content-derived version:

```json
"version": "1.0.0+e767fa115cb6"
```

The suffix is a hash of every playlist's type, id, name and item ids. That makes
it change exactly when it should:

| Change | Version |
| --- | --- |
| A playlist is added or removed | changes |
| A playlist's name changes on IMDb | changes |
| A playlist's contents change on IMDb | changes |
| Same lists, listed in a different order | **unchanged** |
| Rebuild with no source change | **unchanged** |

A build counter would seem like the obvious choice but is unusable here: the
counter lives in `last-build.json`, which is neither committed nor persisted
between CI runs, so it would report `1` forever and never tell a client that
anything changed. Do not replace the hash with the build number.

### Picking the right variable

The variable decides the Stremio type, and the build drops any item whose IMDb
`titleType` contradicts it. Put a list in the wrong variable and it will simply
disappear rather than show up as the wrong type:

```
[build] ls051464199: kept 0, dropped 25 whose title type contradicts series
```

A list whose items do not match its variable at all produces no category:

```
[build] ls051464199 ("Yeşilçam") contains no series items; not added as a catalog.
```

### Limits

| Limit | Value | What happens |
| --- | --- | --- |
| Ids per variable | unlimited | — |
| Id format | `ls` + at least 6 digits | Anything else is skipped with a warning |
| Items per list | unlimited | Split into pages of `CATALOG_PAGE_SIZE` |
| Duplicate names | first wins | The second is skipped with a warning, since the user cannot tell them apart |

### Verifying a change

Check the run succeeded, then confirm the category is live:

```bash
curl -s https://stremio-worker.github.io/imdb-playlist-stremio/build-info.json
```

It lists every playlist in the build with its type, id, name and item count,
which makes it easy to spot a list that was silently skipped. With the movie and
series lists from above (abridged):

```json
{
  "movieCount": 1,
  "seriesCount": 1,
  "generatedAt": "2026-09-30T11:16:06.008Z",
  "buildNumber": 1,
  "version": "1.0.0+e767fa115cb6",
  "addonUrlPlaceholder": "https://<user>.github.io/imdb-playlist-stremio/manifest.json",
  "playlists": [
    { "type": "movie", "listId": "ls051464199", "name": "Yeşilçam", "itemCount": 25, "pageCount": 1 },
    { "type": "series", "listId": "ls008957859", "name": "Top 250 TV Series", "itemCount": 250, "pageCount": 3 }
  ]
}
```

`version` is the one to compare between runs — see
[Why the version number matters](#why-the-version-number-matters). `buildNumber`
is a local convenience only and reads `1` on every CI run, so it tells you
nothing about how current the live site is.

If a list you configured is missing here, it was skipped. The build log for
that run states which of the reasons below applied.

## Adding it to Stremio

Paste `https://stremio-worker.github.io/imdb-playlist-stremio/manifest.json`
into **Add-ons → Add-on Repository**.

## File layout

Stremio packs `extra` values into a single path segment
(`genre=Top%20250%20TV%20Series&skip=100.json`). Client versions differ in how
they escape a space, so **all three** forms are written:

```
site/catalog/series/imdb-playlist/genre=Top%20250%20TV%20Series.json
site/catalog/series/imdb-playlist/genre=Top+250+TV+Series.json
site/catalog/series/imdb-playlist/genre=Top 250 TV Series.json
```

A playlist with more than 100 items also gets `&skip=100`, `&skip=200`, … pages.

The plain form with literal spaces is **not** redundant. The static host
decodes the request path before it looks at the filesystem, so a request for
`genre=Top%20250%20TV%20Series.json` arrives looking for the file
`genre=Top 250 TV Series.json`. Remove the plain form and every `%20` request
returns 404.

A client that puts a raw space directly in the request line gets
`400 Bad Request` instead — that one is lost at the HTTP layer, before the
server ever looks at the filesystem, so no file on disk can affect it.

## Local development

```bash
cp .env.example .env      # fill in the values
npm install
npm run build             # writes the static files under site/
npm run typecheck         # types only, no emit
```

The same two variables drive a local build, so testing a new list locally is
just:

```bash
IMDB_MOVIE_LISTS=ls0022802 npm run build
IMDB_SERIES_LISTS=ls008957859 npm run build
```

To try a list without touching your `.env`, or to override one page size:

```bash
IMDB_MOVIE_LISTS='ls051464199,ls0022802' CATALOG_PAGE_SIZE=10 npm run build
```

To preview the output locally:

```bash
npx http-server site --cors -p 8080
# http://localhost:8080/manifest.json
```

`.cache/tmdb-cache.json` keeps unchanged items from being re-fetched. Delete it
to force a fresh lookup.

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | Compiles and produces the static addon under `site/` |
| `npm run typecheck` | Type check only |
| `npm run clean` | Removes `dist/`, `site/` and `.cache/` |

## Error behaviour

- A single failing playlist logs a warning and the build continues.
- A playlist containing no items of its declared type is not added.
- If two playlists share a name, the first is kept and the second is skipped
  with a warning, since the user cannot tell them apart by name.
- An invalid `TMDB_API_KEY` (401) fails the build. When no key is set the build
  still succeeds and everything is built from IMDb data.

## Development notes

- The repository is entirely in English: code comments, log lines, error
  messages, docs and labels.
- Playlist names are the one exception in practice: they come from IMDb and are
  whatever the list author named them, so a Turkish list shows a Turkish name.
- `TMDB_LANGUAGE` controls the language TMDB returns titles and overviews in. The
  default is `tr`, so shipped content is Turkish even though the code is not.
- The `main` branch holds source only. Build output (`site/`) is in
  `.gitignore` and CI pushes it to the `gh-pages` branch separately.