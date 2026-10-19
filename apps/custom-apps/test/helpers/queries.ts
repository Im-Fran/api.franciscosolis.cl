import { env } from 'cloudflare:test'

/**
 * Counts the D1 statements the Worker issues while `run` executes, by replacing `env.DB` with a
 * proxy that counts every statement it prepares — the same move the queue captures make by
 * assignment. A batch counts each of its statements, since each was prepared. For asserting that a
 * read stays cheap as the data grows, not for exact budgets.
 */
const countQueries = async <T>(run: () => Promise<T>) => {
  const target = env as { DB: D1Database }
  const real = target.DB
  let statements = 0
  target.DB = new Proxy(real, {
    get(db, property) {
      if (property === 'prepare') {
        return (query: string) => {
          statements += 1
          return db.prepare(query)
        }
      }
      const value = Reflect.get(db, property)
      return typeof value === 'function' ? value.bind(db) : value
    },
  })
  try {
    const result = await run()
    return { result, statements }
  } finally {
    target.DB = real
  }
}

export { countQueries }
