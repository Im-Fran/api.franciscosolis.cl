-- Retires the support console: the client application `0010_support_application.sql` registered,
-- its two application-scoped roles and the `support:agent` / `support:admin` permissions.
--
-- The ticket system is gone — support is plain email to soporte@franciscosolis.cl, handled in a
-- Google Group — so nothing checks these permissions any more, and a client application nothing can
-- sign in to is only a redirect URI waiting to be misused.
--
-- Hand-written and absent from `migrations/meta/_journal.json` for the same reason as `0010`: it
-- contains no DDL, only idempotent data. `0010` itself stays in place, because a migration that has
-- already been applied is history, not configuration — deleting the file would not undo it, and
-- would make a fresh database disagree with a deployed one.
--
-- Every foreign key onto `applications`, `roles` and `permissions` is `ON DELETE CASCADE` (or
-- `SET NULL` for the audit log), so deleting the three kinds of parent row is enough: sessions,
-- refresh tokens, pending authorization requests, invitations and role grants tied to the support
-- application go with it, and the audit trail keeps its rows with the application id cleared.
-- The role and permission deletes are spelled out anyway rather than left to the cascade, so this
-- file does not depend on `PRAGMA foreign_keys` being on to do what it says.
DELETE FROM `role_permissions`
  WHERE `permission_id` IN (
    SELECT `id` FROM `permissions` WHERE `slug` IN ('support:agent', 'support:admin')
  );
--> statement-breakpoint
DELETE FROM `user_roles`
  WHERE `role_id` IN (SELECT `id` FROM `roles` WHERE `application_id` = 'franciscosolis-support');
--> statement-breakpoint
DELETE FROM `roles` WHERE `application_id` = 'franciscosolis-support';
--> statement-breakpoint
DELETE FROM `permissions` WHERE `slug` IN ('support:agent', 'support:admin');
--> statement-breakpoint
DELETE FROM `applications` WHERE `id` = 'franciscosolis-support';
