# Standalone App Pages

Product pages for the applications built at [franciscosolis.cl](https://franciscosolis.cl), all to
one house standard: a banner, a row of tabs under it, and the content behind them.

This is an internal Cloudflare Worker of the [`api.franciscosolis.cl`](../../README.md) monorepo. It
is not reachable on its own — the gateway at `apps/api` fronts it, so its public base URL is
**`https://api.franciscosolis.cl/pages`**. The website renders it at
`franciscosolis.cl/application/<slug>`, and it is edited from the CMS interface at
`franciscosolis.cl/cms/pages`.

## The model

An application page is a row plus four tabs:

| Tab          | What it is                                                                   |
| ------------ | ---------------------------------------------------------------------------- |
| **Overview** | One centred Markdown document. Every page has it.                            |
| **Updates**  | Release notes, newest release first, with a version, a date and store links. |
| **Wiki**     | Documentation with a sidebar, nested at most one level deep.                 |
| **Contact**  | How to reach support, as one Markdown document.                              |

An application turns on the subset it wants, in the order it wants. Nothing else about the layout is
configurable — that is the point: a page built here looks like every other page built here.

## Public API

Everything below is unauthenticated, only ever answers `published` rows, and takes an optional
`?locale=en|es`. Untranslated fields fall back to the row's own text, and every response says which
`locale` it actually came back in.

| Route                                        | What it answers                                     |
| -------------------------------------------- | --------------------------------------------------- |
| `GET /`                                      | The tabs, link kinds and locales this service has    |
| `GET /applications`                          | Published applications, without the tab bodies       |
| `GET /applications/:slug`                    | One page: banner, tabs, links, Overview and Contact  |
| `GET /applications/:slug/updates`            | Release notes, newest release first                  |
| `GET /applications/:slug/updates/:version`   | One release note                                     |
| `GET /applications/:slug/wiki`               | The sidebar, as a tree, without bodies               |
| `GET /applications/:slug/wiki/:page`         | One wiki page with its Markdown                      |

## Editorial API

Everything under `/admin` needs a Bearer access token from the auth service, minted for the CMS
client application and carrying a verified `@franciscosolis.cl` address.

| Route                                                     | What it does                    |
| --------------------------------------------------------- | ------------------------------- |
| `GET /admin/me`                                           | Who the token belongs to        |
| `GET/POST /admin/applications`                            | List / create an application    |
| `GET/PATCH/DELETE /admin/applications/:id`                | One application                 |
| `POST /admin/applications/reorder`                        | Reorder the list                |
| `GET/POST /admin/applications/:id/updates`                | List / add a release note       |
| `GET/PATCH/DELETE /admin/applications/:id/updates/:uid`   | One release note                |
| `GET/POST /admin/applications/:id/wiki`                   | List (`?tree=true`) / add a page |
| `POST /admin/applications/:id/wiki/reorder`               | Reorder the sidebar             |
| `GET/PATCH/DELETE /admin/applications/:id/wiki/:pid`      | One wiki page                   |
| `GET /admin/audit`                                        | The trail of every write        |

Deleting an application deletes its release notes and wiki pages with it. Deleting a wiki *section*
does not: its pages are promoted to the top level of the sidebar instead.

The full, always-current description is the OpenAPI document at
`https://api.franciscosolis.cl/openapi.json`.

## Development

```bash
pnpm install              # from the monorepo root
pnpm --filter pages dev   # http://localhost:8792
pnpm --filter pages test
```

See [CLAUDE.md](./CLAUDE.md) for the design decisions worth not re-deriving.
