CREATE TABLE `heartbeat_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`ip` text,
	`app_version` text,
	`active_seconds` integer,
	`credited_seconds` integer DEFAULT 0 NOT NULL,
	`snapshot` text
);
--> statement-breakpoint
CREATE INDEX `heartbeat_log_installation_time_idx` ON `heartbeat_log` (`installation_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `heartbeat_log_received_idx` ON `heartbeat_log` (`received_at`);--> statement-breakpoint
DROP INDEX `metric_samples_installation_time_unique`;--> statement-breakpoint
ALTER TABLE `metric_samples` ADD `source` text DEFAULT 'batch' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `metric_samples_installation_source_time_unique` ON `metric_samples` (`installation_id`,`source`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_installation_time_idx` ON `metric_samples` (`installation_id`,`recorded_at`);