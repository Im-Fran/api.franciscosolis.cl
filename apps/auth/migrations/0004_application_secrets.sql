-- Moves the single `applications.client_secret_hash` into `application_secrets`, then drops the
-- column. Only the DROP COLUMN at the bottom is generator output; the two statements before it are
-- hand-written, because `drizzle-kit generate` emits schema changes and never the data move that
-- has to precede them — dropping the column first would quietly turn every confidential client
-- into a public one.
--
-- A client that had a secret also gets `client_secret_post`, which is the only method the token
-- endpoint accepted before this migration, so existing clients keep authenticating unchanged. The
-- hint is a placeholder: only the hash was ever stored, so there is nothing to take the first
-- characters of the secret from.

INSERT INTO `application_secrets` (`id`, `application_id`, `secret_hash`, `hint`, `label`, `created_at`, `updated_at`)
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
      || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2)
      || '-' || lower(hex(randomblob(6))),
    `id`,
    `client_secret_hash`,
    'legacy',
    'Migrated from applications.client_secret_hash',
    unixepoch(),
    unixepoch()
  FROM `applications`
  WHERE `client_secret_hash` IS NOT NULL;
--> statement-breakpoint
UPDATE `applications` SET `token_endpoint_auth_method` = 'client_secret_post' WHERE `client_secret_hash` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `applications` DROP COLUMN `client_secret_hash`;
