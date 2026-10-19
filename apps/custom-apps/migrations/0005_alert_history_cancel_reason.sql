-- Alerts outlive their rule: `rule_id` becomes nullable with ON DELETE SET NULL, and the rule's name
-- and kind are snapshotted onto each alert so one whose rule is gone still reads right. SQLite cannot
-- change a foreign key in place, so the table is rebuilt. Nothing references `alerts`, so dropping it
-- trips no foreign key whether or not the PRAGMA takes effect inside D1's transaction.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text,
	`rule_name` text,
	`rule_kind` text,
	`app_id` text NOT NULL,
	`installation_id` text,
	`subject` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`value` real,
	`details` text,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`opened_at` integer NOT NULL,
	`last_triggered_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by` text,
	`resolved_at` integer,
	`resolved_by` text,
	`notified_at` integer,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Hand-edited: drizzle-kit selected `rule_name` / `rule_kind` from the old table, which has neither,
-- and SQLite reads an unknown double-quoted column as a string literal. The snapshot is backfilled
-- from each alert's rule instead (every existing alert has one: the old column was NOT NULL with a
-- cascading delete).
INSERT INTO `__new_alerts`("id", "rule_id", "rule_name", "rule_kind", "app_id", "installation_id", "subject", "status", "value", "details", "occurrences", "opened_at", "last_triggered_at", "acknowledged_at", "acknowledged_by", "resolved_at", "resolved_by", "notified_at")
SELECT a."id", a."rule_id", r."name", r."kind", a."app_id", a."installation_id", a."subject", a."status", a."value", a."details", a."occurrences", a."opened_at", a."last_triggered_at", a."acknowledged_at", a."acknowledged_by", a."resolved_at", a."resolved_by", a."notified_at"
FROM `alerts` a LEFT JOIN `alert_rules` r ON r."id" = a."rule_id";--> statement-breakpoint
DROP TABLE `alerts`;--> statement-breakpoint
ALTER TABLE `__new_alerts` RENAME TO `alerts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_rule_subject_unresolved_unique` ON `alerts` (`rule_id`,`subject`) WHERE status != 'resolved';--> statement-breakpoint
CREATE INDEX `alerts_status_opened_idx` ON `alerts` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `alerts_app_idx` ON `alerts` (`app_id`,`opened_at`);--> statement-breakpoint
ALTER TABLE `contracts` ADD `cancel_reason` text;
