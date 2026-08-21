-- Lets Cloudflare preview deployments of the front-ends call this Worker cross-origin.
--
-- Hand-written like `0001_seed.sql`, `0002_cms_application.sql` and `0005_repair_client_config.sql`,
-- and deliberately absent from `migrations/meta/_journal.json` for the same reason: it contains no
-- DDL, only idempotent data, so the drizzle snapshot stays accurate without it being listed there.
--
-- A Worker deployed from a branch or a version is served at
-- `<alias>-<worker>.franciscosolis.workers.dev` — a hostname that does not exist until the
-- deployment does and changes with the branch, so it can never be registered ahead of time. CORS
-- here is decided from the registered clients (`src/middleware/cors.ts`), so without an entry that
-- describes those hostnames, a preview build of the site cannot make a single call to this Worker:
-- its preflight is refused and sign-in never starts.
--
-- `https://*.franciscosolis.workers.dev` is the account's own `workers.dev` subdomain. The wildcard
-- is matched on a dot boundary and only for CORS (see `src/lib/origins.ts`); redirect URIs stay
-- exact, so a preview still has to have its own callback URI registered before it can complete a
-- sign-in. This only opens the preflight, which is what makes the failure legible instead of silent.
--
-- Adds only, and only when the entry is not already there, so re-applying it is a no-op.

UPDATE `applications`
  SET `allowed_origins` = json_insert(
    CASE
      WHEN json_valid(`allowed_origins`) AND json_type(`allowed_origins`) = 'array' THEN `allowed_origins`
      ELSE '[]'
    END,
    '$[#]',
    'https://*.franciscosolis.workers.dev'
  )
  WHERE `id` IN ('franciscosolis-web', 'franciscosolis-cms')
    AND NOT EXISTS (
      SELECT 1 FROM json_each(
        CASE
          WHEN json_valid(`applications`.`allowed_origins`) AND json_type(`applications`.`allowed_origins`) = 'array'
            THEN `applications`.`allowed_origins`
          ELSE '[]'
        END
      )
      WHERE `json_each`.`value` = 'https://*.franciscosolis.workers.dev'
    );
