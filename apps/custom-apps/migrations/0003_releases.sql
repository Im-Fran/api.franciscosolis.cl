CREATE TABLE `ci_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`label` text,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_tokens_hash_unique` ON `ci_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `ci_tokens_app_idx` ON `ci_tokens` (`app_id`);--> statement-breakpoint
CREATE TABLE `release_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`release_id` text NOT NULL,
	`app_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`status` text NOT NULL,
	`from_version` text,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `release_reports_release_idx` ON `release_reports` (`release_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `release_reports_installation_idx` ON `release_reports` (`installation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `release_reports_app_time_idx` ON `release_reports` (`app_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` text NOT NULL,
	`channel` text NOT NULL,
	`platform` text NOT NULL,
	`arch` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`rollout_percent` integer DEFAULT 0 NOT NULL,
	`rollout_installations` text DEFAULT '[]' NOT NULL,
	`min_version` text,
	`notes` text,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`signature` text NOT NULL,
	`uploaded_by` text,
	`published_at` integer,
	`published_by` text,
	`status_reason` text,
	`status_changed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `releases_line_version_unique` ON `releases` (`app_id`,`channel`,`platform`,`arch`,`version`);--> statement-breakpoint
CREATE INDEX `releases_app_status_idx` ON `releases` (`app_id`,`status`);--> statement-breakpoint
ALTER TABLE `apps` ADD `release_public_key` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `update_health_timeout_seconds` integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `update_max_failures` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `rollout_pause_rollback_percent` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `rollout_pause_crash_percent` integer DEFAULT 20 NOT NULL;