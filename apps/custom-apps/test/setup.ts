import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { captureNotifications } from './helpers/notifications'
import { captureTelemetry } from './helpers/telemetry'

/**
 * Each test file gets its own isolated D1 instance, so the schema is created once per file from the
 * same `migrations/` directory Wrangler applies in production.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

/**
 * The pool does not roll a test back, so every test starts from empty tables — children before
 * parents, for the foreign keys. `audit_logs` is the exception: the database refuses to delete from
 * it, which is the point, so tests assert on the rows of the resources they created themselves.
 *
 * The telemetry queue is replaced by a capture for every test: the simulated one would deliver to
 * this same Worker's consumer in the background, writing rows while a test is asserting on them.
 * Tests that want the rows written hand the captured messages to the consumer explicitly. The
 * notifications queue is captured the same way: its consumer is another Worker, so what was
 * published is only ever read back from the capture.
 */
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM release_reports'),
    env.DB.prepare('DELETE FROM releases'),
    env.DB.prepare('DELETE FROM ci_tokens'),
    env.DB.prepare('DELETE FROM alerts'),
    env.DB.prepare('DELETE FROM alert_rules'),
    env.DB.prepare('DELETE FROM message_receipts'),
    env.DB.prepare('DELETE FROM messages'),
    env.DB.prepare('DELETE FROM flags'),
    env.DB.prepare('DELETE FROM config_versions'),
    env.DB.prepare('DELETE FROM crash_reports'),
    env.DB.prepare('DELETE FROM crash_groups'),
    env.DB.prepare('DELETE FROM log_entries'),
    env.DB.prepare('DELETE FROM screenshots'),
    env.DB.prepare('DELETE FROM commands'),
    env.DB.prepare('DELETE FROM company_contacts'),
    env.DB.prepare('DELETE FROM app_keys'),
    env.DB.prepare('DELETE FROM installations'),
    env.DB.prepare('DELETE FROM apps'),
    env.DB.prepare('DELETE FROM contacts'),
    env.DB.prepare('DELETE FROM companies'),
    env.DB.prepare('DELETE FROM metric_samples'),
    env.DB.prepare('DELETE FROM usage_events'),
    env.DB.prepare('DELETE FROM heartbeat_log'),
    env.DB.prepare('DELETE FROM usage_hourly'),
    env.DB.prepare('DELETE FROM installation_daily'),
  ])
  captureTelemetry()
  captureNotifications()
})
