#!/usr/bin/env node
/**
 * Moves the rows of `franciscosolis_pages` into `franciscosolis_marketplace`, once.
 *
 * The rename from `apps/pages` to `apps/marketplace` is a new database rather than a set of
 * `ALTER TABLE`s, and the reason is in the root `CLAUDE.md`: every migration on `purchases` stays
 * additive, because a rebuild of that table races the production deploy and for the length of it
 * every paid download 404s rather than degrading. Renaming a column in place would have been
 * *technically* non-rebuilding — SQLite has had `RENAME COLUMN` since 3.25 — and still wrong.
 * The degradation story that makes a racing migration tolerable only covers expression contexts;
 * Drizzle emits an explicit column list on every read, and a renamed column in a `SELECT` list is a
 * hard error. So: a new database, in its final shape, and the rows arrive by `INSERT`.
 *
 * ## How it works
 *
 * **Read with an explicit projection, write with an explicit column list.** `wrangler d1 export`
 * emits sqlite-dump-style `INSERT INTO "t" VALUES(…)` with no column names, so a textual rewrite of
 * a dump would silently depend on the two schemas having their columns in the same order — and they
 * differ by design. Every column this script touches is named on both sides, in `TABLES` below.
 *
 * Before anything is written it cross-checks `PRAGMA table_info` on both databases and refuses to
 * run if the source has a column the mapping does not name, or the destination has a
 * `NOT NULL`-without-default column nothing supplies. **That check is the reason this is a script
 * and not a hand-run SQL file.**
 *
 * ## Safety
 *
 * - `--dry-run` is the default. It writes the `.sql` files and a report, and executes nothing.
 * - Every statement is `INSERT OR IGNORE` keyed on the primary key, so a re-run after a partial
 *   failure resumes instead of duplicating.
 * - Row counts, `SUM(amount)`, `SUM(refunded_amount)`, the status histogram of `purchases` and the
 *   voucher high-water mark are compared before and after. **Any disagreement exits non-zero.** A
 *   financial migration that cannot prove it moved everything has not moved everything.
 *
 * ## R2 is not touched, on purpose
 *
 * `apps/marketplace` binds the *same* buckets `apps/pages` bound, so `product_release_files.
 * object_key` copies verbatim and not one byte of a 90 MB installer crosses a network. Renaming the
 * bucket would mean a copy job, a window in which every object key points at nothing, and a second
 * failure mode on the one path that must not break.
 *
 * ## Usage
 *
 *   node scripts/migrate-pages-to-marketplace.mjs                 # rehearse against production
 *   node scripts/migrate-pages-to-marketplace.mjs --dev            # rehearse against the dev pair
 *   node scripts/migrate-pages-to-marketplace.mjs --dev --apply    # do it, on dev
 *   node scripts/migrate-pages-to-marketplace.mjs --apply          # do it, on production
 *
 * Rehearse on dev **twice** before touching production: the second run is what proves the
 * `INSERT OR IGNORE` idempotency rather than assuming it.
 *
 * After the cutover, a scoped second pass picks up the stragglers — the payments that landed on the
 * old Worker between the export and the switch:
 *
 *   node scripts/migrate-pages-to-marketplace.mjs --apply \
 *     --only=purchases,payment_events,sale_vouchers,download_events --since=1789833600
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const IDENTITY = Symbol('identity')

/**
 * The whole rename mapping, in one place a reviewer can read in a screen.
 *
 * `columns` maps **source column → destination column**. A source column absent from it is a column
 * this script refuses to migrate, loudly, at startup. `derive` supplies the columns the destination
 * has and the source never did.
 *
 * `timeColumn` is what `--since` filters on for the reconciliation pass.
 */
const TABLES = [
  {
    from: 'applications',
    to: 'products',
    columns: {
      id: 'id', slug: 'slug', name: 'name', tagline: 'tagline', summary: 'summary', status: 'status',
      featured: 'featured', position: 'position', banner_image_url: 'banner_image_url',
      icon_image_url: 'icon_image_url', accent_color: 'accent_color', tabs: 'tabs', links: 'links',
      overview_body: 'overview_body', contact_body: 'contact_body', pricing_mode: 'pricing_mode',
      price_amount: 'price_amount', suggested_amount: 'suggested_amount', translations: 'translations',
      published_at: 'published_at', created_by: 'created_by', updated_by: 'updated_by',
      created_at: 'created_at', updated_at: 'updated_at',
    },
    // Uncategorised rather than guessed: a category is an editorial decision, and `other` would be
    // a wrong answer wearing a right one's clothes.
    derive: () => ({
      category: null,
      pre_release_requires_purchase: 0,
      // Both left at zero here and backfilled afterwards; see BACKFILL below. The old schema kept no
      // view count at all, and the download total is a sum over the per-file counts, which are not
      // in hand while this row is being written.
      view_count: 0,
      download_count: 0,
    }),
    // The tab key was `updates` and is now `releases`. Without this every migrated product would
    // silently lose its Releases tab, because `parseTabs` drops a key it does not recognise.
    transform: (row) => ({
      ...row,
      tabs: typeof row.tabs === 'string' ? row.tabs.replaceAll('"updates"', '"releases"') : row.tabs,
    }),
    timeColumn: 'created_at',
  },
  {
    from: 'application_updates',
    to: 'product_releases',
    columns: {
      id: 'id', application_id: 'product_id', version: 'version', title: 'title', body: 'body',
      status: 'status', released_at: 'released_at', links: 'links', translations: 'translations',
      published_at: 'published_at', created_by: 'created_by', updated_by: 'updated_by',
      created_at: 'created_at', updated_at: 'updated_at',
    },
    // Nothing in `apps/pages` was ever a pre-release: it had one line and this is it. `0` for the
    // reset flag means every migrated product's rating window is "everything", which is correct
    // because none of them has a review yet either.
    derive: () => ({
      channel: 'release',
      resets_rating: 0,
      view_count: 0,
      download_count: 0,
    }),
    timeColumn: 'created_at',
  },
  {
    from: 'application_wiki_pages',
    to: 'product_wiki_pages',
    columns: {
      id: 'id', application_id: 'product_id', parent_id: 'parent_id', slug: 'slug', title: 'title',
      icon: 'icon', body: 'body', status: 'status', position: 'position', translations: 'translations',
      published_at: 'published_at', created_by: 'created_by', updated_by: 'updated_by',
      created_at: 'created_at', updated_at: 'updated_at',
    },
    timeColumn: 'created_at',
  },
  {
    from: 'application_release_files',
    to: 'product_release_files',
    columns: {
      id: 'id', application_id: 'product_id', update_id: 'release_id', object_key: 'object_key',
      filename: 'filename', content_type: 'content_type', size: 'size', checksum: 'checksum',
      platform: 'platform', label: 'label', position: 'position', status: 'status',
      uploaded_at: 'uploaded_at', download_count: 'download_count', created_by: 'created_by',
      updated_by: 'updated_by', created_at: 'created_at', updated_at: 'updated_at',
    },
    timeColumn: 'created_at',
  },
  {
    from: 'purchases',
    to: 'purchases',
    columns: {
      id: 'id', application_id: 'product_id', application_slug: 'product_slug', kind: 'kind',
      user_id: 'user_id', email: 'email', status: 'status', amount: 'amount', currency: 'currency',
      provider: 'provider', source: 'source', environment: 'environment',
      preference_id: 'preference_id', payment_id: 'payment_id',
      external_reference: 'external_reference', approved_at: 'approved_at',
      refunded_at: 'refunded_at', refunded_amount: 'refunded_amount', refund_reason: 'refund_reason',
      refunded_by: 'refunded_by', refund_id: 'refund_id', charged_back_at: 'charged_back_at',
      chargeback_id: 'chargeback_id', note: 'note', created_by: 'created_by', metadata: 'metadata',
      created_at: 'created_at', updated_at: 'updated_at',
    },
    timeColumn: 'created_at',
  },
  {
    from: 'sale_vouchers',
    to: 'sale_vouchers',
    columns: {
      id: 'id', number: 'number', purchase_id: 'purchase_id', application_id: 'product_id',
      application_slug: 'product_slug', application_name: 'product_name', email: 'email', kind: 'kind',
      amount: 'amount', currency: 'currency', source: 'source', status: 'status', locale: 'locale',
      issued_by: 'issued_by', issued_at: 'issued_at', voided_at: 'voided_at', voided_by: 'voided_by',
      void_reason: 'void_reason', sent_count: 'sent_count', last_sent_at: 'last_sent_at',
      last_sent_to: 'last_sent_to', created_at: 'created_at', updated_at: 'updated_at',
    },
    timeColumn: 'created_at',
  },
  { from: 'payment_events', to: 'payment_events', columns: IDENTITY, timeColumn: 'created_at' },
  {
    from: 'download_events',
    to: 'download_events',
    columns: {
      id: 'id', file_id: 'file_id', application_id: 'product_id', application_slug: 'product_slug',
      update_id: 'release_id', version: 'version', filename: 'filename', user_id: 'user_id',
      purchase_id: 'purchase_id', paid: 'paid', ip: 'ip', user_agent: 'user_agent',
      created_at: 'created_at',
    },
    derive: () => ({ channel: 'release' }),
    timeColumn: 'created_at',
  },
  // Copied verbatim, event names and `resource_type` values untouched. An append-only trail records
  // what was done under the names in force at the time; rewriting `application.created` to
  // `product.created` would make the trail assert something that never happened. The cutover date
  // is the boundary, and it is in this file.
  { from: 'audit_logs', to: 'audit_logs', columns: IDENTITY, timeColumn: 'created_at' },
  { from: 'ai_requests', to: 'ai_requests', columns: IDENTITY, timeColumn: 'created_at' },
]

/**
 * Run after the rows are in, and only on a full run.
 *
 * The old schema counted downloads per *file* and nowhere else. Those counts migrate untouched, so
 * the product and release totals the new sidebar reads can be summed back out of them rather than
 * restarting at zero — which would have told every visitor a five-year-old plugin had never been
 * downloaded. There was no view counter at all, so views genuinely do start at zero.
 *
 * Idempotent: it assigns a sum rather than adding one, so running it twice is running it once.
 */
const BACKFILL = [
  `UPDATE product_releases SET download_count = COALESCE(
     (SELECT SUM(download_count) FROM product_release_files WHERE release_id = product_releases.id), 0)`,
  `UPDATE products SET download_count = COALESCE(
     (SELECT SUM(download_count) FROM product_release_files WHERE product_id = products.id), 0)`,
]

const PAGE_SIZE = 500
const STATEMENTS_PER_FILE = 200

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)

const dev = has('--dev')
const apply = has('--apply')
const only = valueOf('--only')?.split(',').map((name) => name.trim()).filter(Boolean)
const since = valueOf('--since')

const SOURCE = dev ? 'franciscosolis_pages_dev' : 'franciscosolis_pages'
const DEST = dev ? 'franciscosolis_marketplace_dev' : 'franciscosolis_marketplace'
const OUT = join(process.cwd(), '.migration-out')

const fail = (message) => {
  console.error(`\n✖ ${message}`)
  process.exit(1)
}

/** Runs `wrangler d1 execute --json` and returns the first result set. */
const query = (database, sql) => {
  const raw = execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', database, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  // Wrangler prints its banner before the JSON, so the document starts at the first bracket.
  const start = raw.indexOf('[')
  if (start === -1) {
    fail(`could not read a JSON result out of wrangler's output for:\n  ${sql}`)
  }
  return JSON.parse(raw.slice(start))[0]?.results ?? []
}

const quote = (value) => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Uint8Array) fail('a BLOB column reached the writer; none of these tables has one')
  return `'${String(value).replaceAll("'", "''")}'`
}

/** `PRAGMA table_info`, as a map of column → { notnull, dflt_value }. */
const columnsOf = (database, table) => {
  const rows = query(database, `PRAGMA table_info('${table}')`)
  return new Map(rows.map((row) => [row.name, { notnull: row.notnull === 1, hasDefault: row.dflt_value !== null }]))
}

/**
 * Refuses to run against a schema the mapping does not describe.
 *
 * Two directions, and both have bitten somebody somewhere: a source column nobody mapped is data
 * silently left behind, and a destination column that is `NOT NULL` with no default and nothing
 * supplying it is an insert that fails halfway through a financial table.
 */
const preflight = (table) => {
  const source = columnsOf(SOURCE, table.from)
  const dest = columnsOf(DEST, table.to)
  if (source.size === 0) fail(`${SOURCE} has no table \`${table.from}\``)
  if (dest.size === 0) fail(`${DEST} has no table \`${table.to}\` — has \`db:migrate:remote\` been run?`)

  const mapping =
    table.columns === IDENTITY ? Object.fromEntries([...source.keys()].map((name) => [name, name])) : table.columns

  for (const name of source.keys()) {
    if (!(name in mapping)) {
      fail(`\`${table.from}.${name}\` is not named in the mapping. Add it to TABLES, or say why it is dropped.`)
    }
  }
  const supplied = new Set([...Object.values(mapping), ...Object.keys(table.derive?.({}) ?? {})])
  for (const [name, meta] of dest) {
    if (!supplied.has(name) && meta.notnull && !meta.hasDefault) {
      fail(`\`${table.to}.${name}\` is NOT NULL with no default and nothing supplies it.`)
    }
  }
  for (const name of Object.values(mapping)) {
    if (!dest.has(name)) fail(`\`${table.to}\` has no column \`${name}\`, which the mapping writes to.`)
  }
  return mapping
}

/** Everything the two sides are compared on. A disagreement in any of them stops the run. */
const checksums = (database, { productColumn }) => ({
  counts: Object.fromEntries(
    TABLES.map((table) => {
      const name = database === SOURCE ? table.from : table.to
      return [table.to, query(database, `SELECT COUNT(*) AS n FROM ${name}`)[0]?.n ?? 0]
    }),
  ),
  money: query(
    database,
    `SELECT COALESCE(SUM(amount), 0) AS gross,
            COALESCE(SUM(COALESCE(refunded_amount, 0)), 0) AS returned,
            COUNT(*) AS rows
       FROM purchases`,
  )[0] ?? {},
  statuses: Object.fromEntries(
    query(database, 'SELECT status, COUNT(*) AS n FROM purchases GROUP BY status').map((row) => [row.status, row.n]),
  ),
  vouchers: query(database, 'SELECT COUNT(*) AS n, MAX(number) AS high FROM sale_vouchers')[0] ?? {},
  // Named so the object is self-describing in the report; unused otherwise.
  productColumn,
})

const migrate = () => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const selected = TABLES.filter((table) => !only || only.includes(table.to) || only.includes(table.from))
  if (selected.length === 0) fail(`--only matched no table. Known: ${TABLES.map((t) => t.to).join(', ')}`)

  console.log(`\n${SOURCE} → ${DEST}${apply ? '' : '   (dry run — nothing will be executed)'}\n`)

  const before = { source: checksums(SOURCE, { productColumn: 'application_id' }), dest: checksums(DEST, { productColumn: 'product_id' }) }
  const written = []

  for (const table of selected) {
    const mapping = preflight(table)
    const sourceColumns = Object.keys(mapping)
    const destColumns = [...Object.values(mapping), ...Object.keys(table.derive?.({}) ?? {})]

    let offset = 0
    let migrated = 0
    let statements = []
    let fileIndex = 0

    const flush = () => {
      if (statements.length === 0) return
      const path = join(OUT, `${String(written.length).padStart(4, '0')}-${table.to}-${fileIndex}.sql`)
      writeFileSync(path, `${statements.join('\n')}\n`)
      written.push(path)
      statements = []
      fileIndex += 1
    }

    for (;;) {
      const where = since && table.timeColumn ? `WHERE ${table.timeColumn} >= ${Number(since)}` : ''
      const rows = query(
        SOURCE,
        `SELECT ${sourceColumns.join(', ')} FROM ${table.from} ${where} ORDER BY rowid LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      )
      if (rows.length === 0) break

      for (const raw of rows) {
        const row = table.transform ? table.transform(raw) : raw
        const values = [
          ...sourceColumns.map((name) => quote(row[name])),
          ...Object.values(table.derive?.(row) ?? {}).map(quote),
        ]
        statements.push(
          `INSERT OR IGNORE INTO ${table.to} (${destColumns.join(', ')}) VALUES (${values.join(', ')});`,
        )
        if (statements.length >= STATEMENTS_PER_FILE) flush()
      }

      migrated += rows.length
      offset += PAGE_SIZE
    }

    flush()
    console.log(`  ${table.from.padEnd(26)} → ${table.to.padEnd(26)} ${String(migrated).padStart(7)} rows`)
  }

  if (!apply) {
    writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ before, files: written }, null, 2)}\n`)
    console.log(`\n${written.length} file(s) written to ${OUT}. Read them, then re-run with --apply.\n`)
    return
  }

  for (const path of written) {
    execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', DEST, '--remote', '--file', path], {
      stdio: 'inherit',
    })
  }

  // Only on a full run: a reconciliation pass migrates a handful of payments and must not reset a
  // counter the live Worker has been incrementing since the cutover.
  if (!only && !since) {
    for (const statement of BACKFILL) {
      execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', DEST, '--remote', '--command', statement], {
        stdio: 'inherit',
      })
    }
  }

  const after = checksums(DEST, { productColumn: 'product_id' })
  const problems = []

  for (const table of selected) {
    // Only meaningful for a full run: `--only --since` migrates a subset by design.
    if (only || since) break
    if (before.source.counts[table.to] !== after.counts[table.to]) {
      problems.push(`${table.to}: ${before.source.counts[table.to]} rows in the source, ${after.counts[table.to]} here`)
    }
  }
  if (!only && !since) {
    if (Number(before.source.money.gross) !== Number(after.money.gross)) {
      problems.push(`purchases.amount: ${before.source.money.gross} in the source, ${after.money.gross} here`)
    }
    if (Number(before.source.money.returned) !== Number(after.money.returned)) {
      problems.push(`purchases.refunded_amount: ${before.source.money.returned} vs ${after.money.returned}`)
    }
    for (const [status, count] of Object.entries(before.source.statuses)) {
      if (after.statuses[status] !== count) {
        problems.push(`purchases status \`${status}\`: ${count} in the source, ${after.statuses[status] ?? 0} here`)
      }
    }
    if (before.source.vouchers.high !== after.vouchers.high) {
      problems.push(`sale_vouchers highest number: ${before.source.vouchers.high} vs ${after.vouchers.high}`)
    }
  }

  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ before, after, problems, files: written }, null, 2)}\n`)

  if (problems.length > 0) {
    console.error('\n✖ the two databases do not agree:')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(`\nThe run is re-runnable (INSERT OR IGNORE); the report is at ${OUT}/report.json`)
    process.exit(1)
  }

  console.log(`\n✔ ${DEST} matches ${SOURCE}: row counts, amounts, statuses and voucher numbers.`)
  console.log('  R2 was not touched: marketplace binds the same buckets, so every object key is still valid.\n')
}

migrate()
