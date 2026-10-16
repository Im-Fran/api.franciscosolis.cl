-- Registers the custom-apps panel as a client application, and the permission that lets somebody in.
--
-- Hand-written like `0010_support_application.sql`, and absent from `migrations/meta/_journal.json`
-- for the same reason: it contains no DDL, only idempotent data.
--
-- A client application of its own, for the reason the marketplace console has one: `apps/custom-apps`
-- accepts only its own audience (`CUSTOM_APPS_ALLOWED_AUDIENCES`), and roles and permissions are
-- resolved per application here (`getUserAuthorization` in src/services/users.ts). That panel holds
-- clients' contact details and their devices — and later their credentials — and is meant for one
-- person, so "anyone with a @franciscosolis.cl address" is not the gate: `custom-apps:admin` is.
--
-- A public client — `token_endpoint_auth_method` is `none` and there is no row in
-- `application_secrets` — so PKCE is mandatory and redirect URIs are matched byte for byte. This file
-- runs against the development database too, where the panel lives on dev.franciscosolis.cl; add
-- that callback there with `pnpm run applications -- update franciscosolis-custom-apps
-- --add-redirect-uri https://dev.franciscosolis.cl/custom-apps/callback --dev --remote` rather than
-- putting a development URI into production's row.
INSERT OR IGNORE INTO `applications`
  (`id`, `name`, `description`, `token_endpoint_auth_method`, `redirect_uris`, `grant_types`, `require_pkce`, `is_active`) VALUES
  (
    'franciscosolis-custom-apps',
    'franciscosolis.cl Custom Apps',
    'Panel for the bespoke apps built for clients. Restricted by apps/custom-apps to @franciscosolis.cl accounts holding custom-apps:admin.',
    'none',
    '["https://franciscosolis.cl/custom-apps/callback","http://localhost:5173/custom-apps/callback"]',
    '["authorization_code","refresh_token"]',
    true,
    true
  );
--> statement-breakpoint
-- Preview deployments of the front-end, matched on a dot boundary and only for CORS — the same entry
-- and the same reasoning as `0006_preview_origins.sql`. Redirect URIs stay exact.
UPDATE `applications`
  SET `allowed_origins` = json_insert(
    CASE
      WHEN json_valid(`allowed_origins`) AND json_type(`allowed_origins`) = 'array' THEN `allowed_origins`
      ELSE '[]'
    END,
    '$[#]',
    'https://*.franciscosolis.workers.dev'
  )
  WHERE `id` = 'franciscosolis-custom-apps'
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
--> statement-breakpoint
-- The one capability `apps/custom-apps` checks. Deliberately NOT in `GUARDED_PERMISSIONS`
-- (`src/lib/config.ts`): that list is for permissions whose deletion would brick this Worker's own
-- administration API, and the panel can be turned off without breaking auth.
INSERT OR IGNORE INTO `permissions` (`id`, `slug`, `name`, `description`) VALUES
  ('3f9c2a61-7d4e-4b8a-9c15-2e6f0a8b4d71', 'custom-apps:admin', 'Custom apps administrator', 'Use the custom-apps panel: clients, their apps, installations and telemetry');
--> statement-breakpoint
-- Application-scoped, because being the custom-apps administrator means nothing to the CMS or the
-- website.
INSERT OR IGNORE INTO `roles` (`id`, `application_id`, `slug`, `name`, `description`, `is_default`) VALUES
  (
    '6b2e8d40-1c7f-4a93-b5e2-9d4a7c3f1e58',
    'franciscosolis-custom-apps',
    'custom-apps-admin',
    'Custom apps administrator',
    'Runs the custom-apps panel',
    false
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission_id`) VALUES
  ('6b2e8d40-1c7f-4a93-b5e2-9d4a7c3f1e58', '3f9c2a61-7d4e-4b8a-9c15-2e6f0a8b4d71');
--> statement-breakpoint
-- The global `admin` role holds every permission, and `0001_seed.sql` filled it by selecting from
-- `permissions` at the time it ran — so the one added above is attached explicitly, or an existing
-- administrator would find themselves locked out of a panel they own.
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
  SELECT '8e7a797c-5012-4a96-a9a2-e8b5bdaeb802', `id`
    FROM `permissions`
   WHERE `slug` = 'custom-apps:admin';
