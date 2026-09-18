import { eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { helpArticles } from '@/db/schema'
import type { Env } from '@/env'
import { EMBEDDING } from '@/lib/config'
import { parseJson } from '@/lib/json'
import { ARTICLE_TRANSLATABLE_FIELDS, availableLocales, localize, parseTranslations } from '@/lib/locales'
import { embed } from '@/services/ai'

type ArticleRow = typeof helpArticles.$inferSelect

/**
 * The semantic half of the help centre.
 *
 * Everything here is best-effort and runs after the D1 write has committed. Vectorize and D1 cannot
 * be transactional with each other, so the reconciliation story is deliberately one-directional:
 * the RAG step always re-reads the article from D1 by id and drops anything that is missing or no
 * longer published. An orphaned vector therefore costs one wasted slot in a top-k, never a leaked
 * draft — which is why there is no nightly sweep to build and keep running.
 */

/**
 * Splits an article into pieces small enough to embed usefully.
 *
 * A whole article embedded as one vector is a blurred average of everything it says, and matches
 * nothing in particular. Splitting on headings follows the shape the author already gave it; the
 * hard wrap afterwards is for the section that is a wall of prose.
 */
const chunk = (text: string): string[] => {
  const sections = text
    .split(/\n(?=#{2,3}\s)/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0)

  const pieces: string[] = []
  for (const section of sections) {
    if (section.length <= EMBEDDING.maxChunkChars) {
      pieces.push(section)
      continue
    }

    let current = ''
    for (const paragraph of section.split(/\n{2,}/)) {
      if (current.length + paragraph.length > EMBEDDING.maxChunkChars && current.length > 0) {
        pieces.push(current.trim())
        current = ''
      }
      current += `${paragraph}\n\n`
    }
    if (current.trim().length > 0) {
      pieces.push(current.trim())
    }
  }

  return pieces
}

/** `<articleId>:<locale>:<index>` — deterministic, so a re-index replaces rather than accumulates. */
const vectorId = (articleId: string, locale: string, index: number) => `${articleId}:${locale}:${index}`

/**
 * Rewrites this article's vectors.
 *
 * The ids actually written are stored on the row. Recomputing the list from the current chunk count
 * on the next pass would miss the trailing chunks of an article that got *shorter*, and leave them
 * answering searches about text nobody can read any more.
 */
const reindexVectors = async (db: Database, env: Env, article: ArticleRow): Promise<number> => {
  const previous = parseJson<string[]>(article.vectorIds, [])

  if (previous.length > 0) {
    await env.VECTORIZE.deleteByIds(previous)
  }

  if (article.status !== 'published') {
    await db.update(helpArticles).set({ vectorIds: '[]' }).where(eq(helpArticles.id, article.id))
    return 0
  }

  const translations = parseTranslations(article.translations)
  const vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[] = []

  for (const locale of availableLocales(translations)) {
    const localized = localize(
      { title: article.title, summary: article.summary, body: article.body },
      translations,
      locale,
      ARTICLE_TRANSLATABLE_FIELDS,
    )
    const pieces = chunk([localized.title, localized.summary ?? '', localized.body ?? ''].join('\n\n'))

    for (const [index, piece] of pieces.entries()) {
      const values = await embed(db, env, piece)
      if (!values || values.length !== EMBEDDING.dimensions) {
        // A model that answered with the wrong shape is a model that changed under us. Skipping the
        // chunk keeps the index consistent; upserting a mis-sized vector would make it unusable.
        continue
      }
      vectors.push({
        id: vectorId(article.id, locale, index),
        values,
        metadata: {
          article_id: article.id,
          slug: article.slug,
          locale,
          title: localized.title,
          chunk: piece.slice(0, 400),
        },
      })
    }
  }

  if (vectors.length > 0) {
    await env.VECTORIZE.upsert(vectors)
  }

  await db
    .update(helpArticles)
    .set({ vectorIds: JSON.stringify(vectors.map((vector) => vector.id)), searchIndexedAt: new Date() })
    .where(eq(helpArticles.id, article.id))

  return vectors.length
}

/** Called when an article row goes away entirely. */
const removeVectors = async (env: Env, article: ArticleRow) => {
  const ids = parseJson<string[]>(article.vectorIds, [])
  if (ids.length > 0) {
    await env.VECTORIZE.deleteByIds(ids)
  }
}

export { chunk, reindexVectors, removeVectors, vectorId }
