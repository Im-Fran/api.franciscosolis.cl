-- Registers the CMS front-end as a client application of the auth Worker.
--
-- Hand-written like `0001_seed.sql`, and for the same reason: it contains no DDL, only an
-- idempotent INSERT, so it is deliberately absent from `migrations/meta/_journal.json` and the
-- drizzle snapshot stays accurate.
--
-- The CMS Worker (`apps/cms`) only accepts access tokens whose `aud` is this application id — see
-- `CMS_ALLOWED_AUDIENCES` in apps/cms/wrangler.jsonc. It is a public client (no
-- `client_secret_hash`), so PKCE is mandatory and redirect URIs are matched exactly, with no
-- wildcards. Update the list below through `PATCH /auth/admin/applications/:id` once the CMS
-- front-end has its final URL.

INSERT OR IGNORE INTO `applications` (`id`, `name`, `description`, `client_secret_hash`, `redirect_uris`, `is_active`) VALUES
  (
    'franciscosolis-cms',
    'franciscosolis.cl CMS',
    'Content management front-end for franciscosolis.cl. Restricted to @franciscosolis.cl accounts by the CMS Worker.',
    NULL,
    '["https://cms.franciscosolis.cl/auth/callback","http://localhost:5174/auth/callback"]',
    true
  );
