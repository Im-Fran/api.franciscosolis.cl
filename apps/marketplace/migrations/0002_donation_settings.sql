-- The donation link's settings and the message a donor may leave with a donation
-- (apps/marketplace/src/services/donation-settings.ts). `settings` is new and starts empty: every key
-- falls back to its catalog default, which is the behaviour the link had before this migration —
-- open, no minimum, no maximum, no messages. `purchases` only gains a nullable column, so it stays
-- additive like every migration on that table.
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `purchases` ADD `donor_message` text;