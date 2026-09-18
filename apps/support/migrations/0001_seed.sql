-- Data-only seed: no DDL, and deliberately absent from `meta/_journal.json`.
--
-- Wrangler applies the migrations *directory*; the journal only feeds drizzle's diff. Keeping a
-- seed out of it means `drizzle-kit generate` never sees it and the snapshot stays an accurate
-- description of the schema. The same convention is used by `apps/auth/migrations/0001_seed.sql`
-- and `apps/cms/migrations/0001_seed_landing_content.sql`. The cost, documented in both, is that the
-- next `generate` will emit a colliding number — rename the emitted file and its `tag`.
--
-- `INSERT OR IGNORE` throughout, so re-applying is a no-op rather than an error.

-- Ticket numbers start at 1001, so the first ticket is `FS-1001`. Starting above zero is cosmetic
-- and worth it: `FS-1` reads like a test record, and support references get quoted back at you.
INSERT OR IGNORE INTO `support_counters` (`name`, `value`) VALUES ('ticket', 1000);
--> statement-breakpoint
-- A starter label set, so the console has something to show before anyone curates it. Slugs are the
-- stable identifier; names and colours are editable, and the Spanish text is an override blob in the
-- same shape every translated row here uses.
INSERT OR IGNORE INTO `labels` (`id`, `slug`, `name`, `description`, `color`, `position`, `translations`) VALUES
  ('3f1c0a52-8d2e-4c7b-9a61-1f0d8e4b2c11', 'question', 'Question', 'Somebody asking how something works', '#60A5FA', 10, '{"es":{"name":"Consulta","description":"Alguien preguntando cómo funciona algo"}}'),
  ('6b2d1e73-4a9f-4d18-8c52-2a7e9f3c4d22', 'bug', 'Bug', 'Something is broken and should not be', '#F87171', 20, '{"es":{"name":"Error","description":"Algo está roto y no debería estarlo"}}'),
  ('9c3e2f84-5b1a-4e29-9d63-3b8f0a4d5e33', 'billing', 'Billing', 'Payments, invoices and subscriptions', '#34D399', 30, '{"es":{"name":"Facturación","description":"Pagos, facturas y suscripciones"}}'),
  ('1d4f3a95-6c2b-4f3a-8e74-4c9a1b5e6f44', 'feature-request', 'Feature request', 'A request for something that does not exist yet', '#A855F7', 40, '{"es":{"name":"Sugerencia","description":"Una petición de algo que todavía no existe"}}'),
  ('2e5a4b06-7d3c-4a4b-9f85-5d0b2c6f7a55', 'account', 'Account', 'Sign-in, identity and access', '#FBBF24', 50, '{"es":{"name":"Cuenta","description":"Inicio de sesión, identidad y acceso"}}');
