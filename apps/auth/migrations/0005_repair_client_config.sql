-- Repairs the configuration of the two seeded client applications.
--
-- Hand-written like `0001_seed.sql` and `0002_cms_application.sql`, and deliberately absent from
-- `migrations/meta/_journal.json` for the same reason: it contains no DDL, only idempotent data
-- fixes, so the drizzle snapshot stays accurate without it being listed there.
--
-- Two things were wrong against the deployed database, both of which make the front-end's sign-in
-- fail outright:
--
-- 1. `grant_types` was empty on every application, so the token endpoint answered
--    `unauthorized_client` for every grant and no authorization code could ever be exchanged. An
--    empty list is not a state the API can produce — `grantTypesSchema` requires at least one
--    entry — so it can only mean the column never received the default `0003_oauth_clients.sql`
--    declared for it. It is healed rather than left to be noticed at sign-in, the same way
--    `resolvePkceRule` heals a client that would otherwise be unusable.
--
-- 2. The redirect URIs did not describe where the front-end actually runs. The CMS lives inside
--    the same single-page application as the rest of the site, at `<origin>/apps/cms/callback`,
--    not on a `cms.` subdomain; and local development serves both from Vite on :5173. Redirect
--    URIs are matched exactly, so a URI that is not registered is a dead sign-in.
--
-- Both fixes only ever add: a client whose grants were configured on purpose keeps them, and a
-- redirect URI already present is not duplicated. Re-applying this migration is a no-op.

UPDATE `applications`
  SET `grant_types` = '["authorization_code","refresh_token"]'
  WHERE json_valid(`grant_types`) = 0
     OR json_type(`grant_types`) <> 'array'
     OR json_array_length(`grant_types`) = 0;
--> statement-breakpoint
-- The site itself: production, and the Vite dev server.
UPDATE `applications`
  SET `redirect_uris` = json_insert(`redirect_uris`, '$[#]', 'https://franciscosolis.cl/auth/callback')
  WHERE `id` = 'franciscosolis-web'
    AND json_valid(`redirect_uris`)
    AND json_type(`redirect_uris`) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(`applications`.`redirect_uris`)
        WHERE `json_each`.`value` = 'https://franciscosolis.cl/auth/callback'
    );
--> statement-breakpoint
UPDATE `applications`
  SET `redirect_uris` = json_insert(`redirect_uris`, '$[#]', 'http://localhost:5173/auth/callback')
  WHERE `id` = 'franciscosolis-web'
    AND json_valid(`redirect_uris`)
    AND json_type(`redirect_uris`) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(`applications`.`redirect_uris`)
        WHERE `json_each`.`value` = 'http://localhost:5173/auth/callback'
    );
--> statement-breakpoint
-- The CMS front-end, which is a route of the same single-page application rather than its own site.
-- The `cms.franciscosolis.cl` URIs registered by `0002_cms_application.sql` are left in place: they
-- cost nothing and are where the CMS is expected to move once it has a domain of its own.
UPDATE `applications`
  SET `redirect_uris` = json_insert(`redirect_uris`, '$[#]', 'https://franciscosolis.cl/apps/cms/callback')
  WHERE `id` = 'franciscosolis-cms'
    AND json_valid(`redirect_uris`)
    AND json_type(`redirect_uris`) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(`applications`.`redirect_uris`)
        WHERE `json_each`.`value` = 'https://franciscosolis.cl/apps/cms/callback'
    );
--> statement-breakpoint
UPDATE `applications`
  SET `redirect_uris` = json_insert(`redirect_uris`, '$[#]', 'http://localhost:5173/apps/cms/callback')
  WHERE `id` = 'franciscosolis-cms'
    AND json_valid(`redirect_uris`)
    AND json_type(`redirect_uris`) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM json_each(`applications`.`redirect_uris`)
        WHERE `json_each`.`value` = 'http://localhost:5173/apps/cms/callback'
    );
