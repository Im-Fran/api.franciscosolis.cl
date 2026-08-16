-- Seed data for the auth Worker.
--
-- Hand-written (not produced by `drizzle-kit generate`) because it contains no DDL: it only
-- inserts the baseline permissions, the two global roles and the first client application.
-- Every statement is idempotent (`INSERT OR IGNORE`) so re-applying the migration on a database
-- that already has these rows is a no-op, and the drizzle snapshot stays accurate without this
-- file being listed in `migrations/meta/_journal.json`.

INSERT OR IGNORE INTO `permissions` (`id`, `slug`, `name`, `description`) VALUES
  ('5c6e8462-d3c7-4871-b620-eb9116ee2d3d', 'users:read', 'Read users', 'List and inspect user profiles, their identities and their roles'),
  ('b23011d0-2b85-4448-a40b-7cb11787bd90', 'users:write', 'Write users', 'Update user profiles, enable or disable accounts and assign roles'),
  ('c53180dc-d8dc-41f1-95b7-483cdd5d07e8', 'roles:read', 'Read roles', 'List roles and the permissions attached to them'),
  ('697888c6-81cb-4b7b-89b4-ffa66bf69ac4', 'roles:write', 'Write roles', 'Create and modify roles and their permissions'),
  ('442282cb-8710-4d31-affc-f5a71703a77f', 'invitations:read', 'Read invitations', 'List pending, accepted and revoked invitations'),
  ('4eaebe2a-4275-4170-a1f0-387bdc7bfbd1', 'invitations:write', 'Write invitations', 'Issue and revoke invitations'),
  ('6df5016c-7382-4b08-95eb-c95ecd231f9a', 'applications:read', 'Read applications', 'List registered client applications and their redirect URIs'),
  ('7ccc4700-db5c-4ad1-80f7-c51f99d18ee0', 'applications:write', 'Write applications', 'Register and modify client applications'),
  ('8bdd2e6b-0a18-41e6-a26b-7e4fd68377cf', 'sessions:read', 'Read sessions', 'Inspect the active sessions of any user'),
  ('92dc9cb2-72d9-40e1-92c2-b96ef044740e', 'sessions:revoke', 'Revoke sessions', 'Revoke the sessions of any user'),
  ('3c722208-976b-415b-92d3-407873e9296f', 'audit:read', 'Read audit log', 'Read the authentication audit trail');
--> statement-breakpoint
-- Global roles (`application_id` NULL): they apply to every client application.
INSERT OR IGNORE INTO `roles` (`id`, `application_id`, `slug`, `name`, `description`, `is_default`) VALUES
  ('8e7a797c-5012-4a96-a9a2-e8b5bdaeb802', NULL, 'admin', 'Administrator', 'Full access to the auth administration API', false),
  ('e159f911-541f-4d48-806e-aaa94971c9a9', NULL, 'user', 'User', 'Baseline role granted to every account on first sign-in', true);
--> statement-breakpoint
-- The admin role holds every permission defined above.
INSERT OR IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
  SELECT '8e7a797c-5012-4a96-a9a2-e8b5bdaeb802', `id` FROM `permissions`;
--> statement-breakpoint
-- First client application: the franciscosolis.cl front-end. It is a public client (no
-- `client_secret_hash`), so PKCE is mandatory for it and redirect URIs are matched exactly.
INSERT OR IGNORE INTO `applications` (`id`, `name`, `description`, `client_secret_hash`, `redirect_uris`, `is_active`) VALUES
  (
    'franciscosolis-web',
    'franciscosolis.cl',
    'Public front-end of franciscosolis.cl',
    NULL,
    '["https://franciscosolis.cl/auth/callback","http://localhost:5173/auth/callback"]',
    true
  );
