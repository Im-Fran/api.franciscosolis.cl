CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`threshold` real NOT NULL,
	`window_minutes` integer DEFAULT 15 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`silenced_until` integer,
	`notify_user_id` text,
	`notify_email` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_rules_app_idx` ON `alert_rules` (`app_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
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
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_rule_subject_unresolved_unique` ON `alerts` (`rule_id`,`subject`) WHERE status != 'resolved';--> statement-breakpoint
CREATE INDEX `alerts_status_opened_idx` ON `alerts` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `alerts_app_idx` ON `alerts` (`app_id`,`opened_at`);--> statement-breakpoint
CREATE TABLE `commands` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`delivered_at` integer,
	`completed_at` integer,
	`result` text,
	`created_by` text,
	`cancelled_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commands_installation_created_idx` ON `commands` (`installation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `commands_status_expiry_idx` ON `commands` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `config_versions` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`app_id`, `version`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `crash_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`signature` text NOT NULL,
	`app_version` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`occurrences` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crash_groups_app_signature_version_unique` ON `crash_groups` (`app_id`,`signature`,`app_version`);--> statement-breakpoint
CREATE INDEX `crash_groups_app_seen_idx` ON `crash_groups` (`app_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `crash_reports` (
	`installation_id` text NOT NULL,
	`report_id` text NOT NULL,
	`app_id` text NOT NULL,
	`group_id` text NOT NULL,
	`app_version` text,
	`kind` text,
	`message` text,
	`stack` text,
	`context` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `report_id`)
);
--> statement-breakpoint
CREATE INDEX `crash_reports_group_time_idx` ON `crash_reports` (`group_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `crash_reports_app_time_idx` ON `crash_reports` (`app_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `crash_reports_occurred_idx` ON `crash_reports` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `flags` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'app' NOT NULL,
	`scope_value` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flags_app_key_scope_unique` ON `flags` (`app_id`,`key`,`scope`,`scope_value`);--> statement-breakpoint
CREATE TABLE `log_entries` (
	`installation_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`app_id` text NOT NULL,
	`level` text NOT NULL,
	`severity` integer NOT NULL,
	`message` text NOT NULL,
	`target` text,
	`context` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `entry_id`)
);
--> statement-breakpoint
CREATE INDEX `log_entries_installation_time_idx` ON `log_entries` (`installation_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `log_entries_app_time_idx` ON `log_entries` (`app_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `log_entries_occurred_idx` ON `log_entries` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `message_receipts` (
	`message_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`message_id`, `installation_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`severity` text DEFAULT 'info' NOT NULL,
	`display` text DEFAULT 'banner' NOT NULL,
	`scope` text DEFAULT 'app' NOT NULL,
	`scope_value` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_app_starts_idx` ON `messages` (`app_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`command_id` text,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `screenshots_installation_created_idx` ON `screenshots` (`installation_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `apps` ADD `log_level` text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `screenshots_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `config_schema` text;--> statement-breakpoint
ALTER TABLE `installations` ADD `log_level_override` text;--> statement-breakpoint
ALTER TABLE `installations` ADD `screenshots_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `installations` ADD `socket_connected_at` integer;--> statement-breakpoint
ALTER TABLE `installations` ADD `socket_closed_at` integer;