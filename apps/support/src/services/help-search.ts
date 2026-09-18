import type { Database } from '@/db/client'
import { HELP_SEARCH } from '@/lib/config'
import { ARTICLE_TRANSLATABLE_FIELDS, availableLocales, localize, parseTranslations } from '@/lib/locales'
import type { Locale } from '@/lib/locales'
import type { helpArticles } from '@/db/schema'

/**
 * The lexical half of the help centre: an FTS5 index maintained from application code.
 *
 * **Why not SQL triggers.** The rows in `help_search` are one per (article, locale), derived from a
 * JSON override blob whose field names and locale set are defined in `src/lib/locales.ts`. A trigger
 * would have to re-express `json_extract(new.translations, '$.es.title')` in SQL — duplicating that
 * list somewhere drizzle does not see, TypeScript does not check, and nobody remembers to update the
 * day a third locale or a fourth translatable field lands. The one job triggers keep is the delete
 * safety net in `migrations/0000_init.sql`, because a foreign key cannot reach into a virtual table.
 *
 * **Why unpublishing deletes the rows rather than flagging them.** FTS5 has no useful secondary
 * index, so a `status` column would have to be filtered *after* `MATCH` — which silently eats the
 * `LIMIT` budget and can return an empty page while matches sit further down.
 */

type ArticleRow = typeof helpArticles.$inferSelect

/**
 * Builds an FTS5 `MATCH` expression from whatever somebody typed.
 *
 * `MATCH` takes a query *language*, not a string. Raw input is a syntax-error generator at best —
 * `c++`, an unbalanced quote, a bare `NOT` — and a prefix-expansion denial of service at worst. Each
 * token is therefore wrapped in double quotes, inside which every operator, quote, hyphen, colon,
 * caret, asterisk and parenthesis is inert, and only the last token gets a `*` so that typing
 * "billi" still finds "billing".
 *
 * Returns null for a query with nothing searchable in it. The caller answers with an empty list:
 * `MATCH ''` is a syntax error, and a syntax error from D1 arrives at `onError` as a 500 with the
 * query in the logs.
 */
const toMatchQuery = (input: string): string | null => {
  const tokens = (input.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [])
    .slice(0, HELP_SEARCH.maxTokens)
    .map((token) => token.slice(0, HELP_SEARCH.maxTokenLength))

  if (tokens.length === 0) {
    return null
  }

  return tokens
    .map((token, index) => `"${token.replace(/"/g, '""')}"${index === tokens.length - 1 ? '*' : ''}`)
    .join(' ')
}

type SearchHit = {
  article_id: string
  slug: string
  locale: string
  title: string
  snippet: string
  rank: number
}

/**
 * Runs a search.
 *
 * Two details of `bm25()` that look right and are not:
 *
 * - It takes one weight **per column, including the UNINDEXED ones**, in declaration order — hence
 *   the three leading zeros for `article_id`, `locale` and `slug`.
 * - It returns a **negative** score, so smaller is better. `ORDER BY rank DESC` returns the worst
 *   matches first, and looks entirely plausible while doing it.
 */
const searchArticles = async (
  db: Database,
  options: { query: string; locale: Locale; limit: number },
): Promise<SearchHit[]> => {
  const match = toMatchQuery(options.query)
  if (!match) {
    return []
  }

  const { results } = await db.$client
    .prepare(
      `SELECT article_id, slug, locale,
              snippet(help_search, 3, '<mark>', '</mark>', '…', 12) AS title,
              snippet(help_search, 5, '<mark>', '</mark>', '…', 28) AS snippet,
              bm25(help_search, 0.0, 0.0, 0.0, 10.0, 4.0, 1.0) AS rank
         FROM help_search
        WHERE help_search MATCH ?1 AND locale = ?2
        ORDER BY rank
        LIMIT ?3`,
    )
    .bind(match, options.locale, options.limit)
    .all<SearchHit>()

  return results
}

/**
 * Rewrites this article's rows in the index.
 *
 * Delete-then-insert rather than an upsert: the set of locales an article has can shrink, and an
 * upsert would leave the retired one answering searches forever.
 */
const reindexArticle = async (db: Database, article: ArticleRow) => {
  await db.$client.prepare('DELETE FROM help_search WHERE article_id = ?').bind(article.id).run()

  if (article.status !== 'published') {
    return 0
  }

  const translations = parseTranslations(article.translations)
  const locales = availableLocales(translations)

  const statements = locales.map((locale) => {
    const localized = localize(
      { title: article.title, summary: article.summary, body: article.body },
      translations,
      locale,
      ARTICLE_TRANSLATABLE_FIELDS,
    )
    return db.$client
      .prepare(
        'INSERT INTO help_search (article_id, locale, slug, title, summary, body) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(article.id, locale, article.slug, localized.title, localized.summary ?? '', localized.body ?? '')
  })

  if (statements.length > 0) {
    await db.$client.batch(statements)
  }

  return statements.length
}

const removeFromIndex = async (db: Database, articleId: string) => {
  await db.$client.prepare('DELETE FROM help_search WHERE article_id = ?').bind(articleId).run()
}

export { reindexArticle, removeFromIndex, searchArticles, toMatchQuery }
export type { SearchHit }
