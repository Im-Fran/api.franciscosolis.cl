-- Registers the support console as a client application, and the permissions that make an agent an
-- agent.
--
-- Hand-written like `0001_seed.sql`, `0002_cms_application.sql` and `0006_preview_origins.sql`, and
-- deliberately absent from `migrations/meta/_journal.json` for the same reason: it contains no DDL,
-- only idempotent data, so the drizzle snapshot stays accurate without it being listed there.
--
-- Why this is a client application of its own, when `apps/pages` deliberately reused the CMS's:
-- tickets are *assignable to people*, and "assign to a person" only means anything if there is a
-- defined set of people. Roles and permissions are resolved per application here
-- (`getUserAuthorization` in src/services/users.ts), so a distinct `application_id` is precisely the
-- mechanism that produces one. Under the CMS's audience, "who is an agent" would degenerate into
-- "anyone with a @franciscosolis.cl address", which is not a roster — and it would also mean every
-- support agent could publish the landing page.
--
-- It is a public client — `token_endpoint_auth_method` is `none` and there is no row in
-- `application_secrets` — so PKCE is mandatory and redirect URIs are matched byte for byte. Register
-- the final console URL through `PATCH /auth/admin/applications/:id` rather than editing this file.
--
-- Note the column list: `client_secret_hash`, which `0001_seed.sql` and `0002_cms_application.sql`
-- still write, no longer exists — `0004_application_secrets.sql` moved secrets into rows of their
-- own so two can be valid at once during a rotation.

INSERT OR IGNORE INTO `applications`
  (`id`, `name`, `description`, `token_endpoint_auth_method`, `redirect_uris`, `grant_types`, `require_pkce`, `is_active`) VALUES
  (
    'franciscosolis-support',
    'franciscosolis.cl Support',
    'Support console for franciscosolis.cl. Restricted by apps/support to @franciscosolis.cl accounts holding support:agent.',
    'none',
    '["https://franciscosolis.cl/support/agent/callback","http://localhost:5173/support/agent/callback"]',
    '["authorization_code","refresh_token"]',
    true,
    true
  );
--> statement-breakpoint
-- Preview deployments, matched on a dot boundary and only for CORS — the same entry and the same
-- reasoning as `0006_preview_origins.sql`. Redirect URIs stay exact.
UPDATE `applications`
  SET `allowed_origins` = json_insert(
    CASE
      WHEN json_valid(`allowed_origins`) AND json_type(`allowed_origins`) = 'array' THEN `allowed_origins`
      ELSE '[]'
    END,
    '$[#]',
    'https://*.franciscosolis.workers.dev'
  )
  WHERE `id` = 'franciscosolis-support'
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
-- The two capabilities `apps/support` checks for. `support:agent` is the gate on the whole console;
-- `support:admin` is the second tier over the label catalogue, the help centre and the assistant.
--
-- These are deliberately NOT added to `GUARDED_PERMISSIONS` in `src/lib/config.ts`: that list is for
-- permissions whose deletion would brick this Worker's own administration API. Support can be turned
-- off without breaking auth.
INSERT OR IGNORE INTO `permissions` (`id`, `slug`, `name`, `description`) VALUES
  ('f4c1a7d2-3b8e-4c19-9a52-6d0e7f1b2c33', 'support:agent', 'Support agent', 'Read and answer support tickets'),
  ('a5d2b8e3-4c9f-4d2a-8b63-7e1f8a2c3d44', 'support:admin', 'Support administrator', 'Manage labels, help articles and the answer assistant');
--> statement-breakpoint
-- Application-scoped roles: `application_id` is set, unlike the two global roles in `0001_seed.sql`,
-- because being a support agent means nothing in the context of the CMS or the website.
INSERT OR IGNORE INTO `roles` (`id`, `application_id`, `slug`, `name`, `description`, `is_default`) VALUES
  (
    'b6e3c9f4-5d0a-4e3b-9c74-8f2a9b3d4e55',
    'franciscosolis-support',
    'agent',
    'Support agent',
    'Answers tickets in the support console',
    false
  ),
  (
    'c7f4d0a5-6e1b-4f4c-8d85-9a3b0c4e5f66',
    'franciscosolis-support',
    'support-admin',
    'Support administrator',
    'Everything an agent can do, plus the label catalogue, the help centre and the assistant',
    false
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission_id`) VALUES
  ('b6e3c9f4-5d0a-4e3b-9c74-8f2a9b3d4e55', 'f4c1a7d2-3b8e-4c19-9a52-6d0e7f1b2c33'),
  ('c7f4d0a5-6e1b-4f4c-8d85-9a3b0c4e5f66', 'f4c1a7d2-3b8e-4c19-9a52-6d0e7f1b2c33'),
  ('c7f4d0a5-6e1b-4f4c-8d85-9a3b0c4e5f66', 'a5d2b8e3-4c9f-4d2a-8b63-7e1f8a2c3d44');
--> statement-breakpoint
-- The global `admin` role holds every permission, and `0001_seed.sql` filled it by selecting from
-- `permissions` at the time it ran — so the two added above have to be attached explicitly. Without
-- this, an existing administrator would find themselves locked out of a console they own.
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
  SELECT '8e7a797c-5012-4a96-a9a2-e8b5bdaeb802', `id`
    FROM `permissions`
   WHERE `slug` IN ('support:agent', 'support:admin');
