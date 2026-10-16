CREATE TABLE `app_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text,
	`status` text DEFAULT 'active' NOT NULL,
	`replaced_by` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_keys_key_unique` ON `app_keys` (`key`);--> statement-breakpoint
CREATE INDEX `app_keys_app_idx` ON `app_keys` (`app_id`);--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`domain` text,
	`repository_url` text,
	`presence_mode` text DEFAULT 'ping' NOT NULL,
	`heartbeat_interval_seconds` integer DEFAULT 60 NOT NULL,
	`operating_hours` text,
	`modules` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`state_message` text,
	`state_until` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `apps_company_idx` ON `apps` (`company_id`);--> statement-breakpoint
CREATE INDEX `apps_state_idx` ON `apps` (`state`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`actor_email` text,
	`actor_id` text,
	`resource_type` text,
	`resource_id` text,
	`ip` text,
	`user_agent` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_resource_idx` ON `audit_logs` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`legal_name` text NOT NULL,
	`trade_name` text,
	`rut` text,
	`business_activity` text,
	`address` text,
	`is_company` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_rut_unique` ON `companies` (`rut`);--> statement-breakpoint
CREATE INDEX `companies_legal_name_idx` ON `companies` (`legal_name`);--> statement-breakpoint
CREATE TABLE `company_contacts` (
	`company_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`company_id`, `contact_id`),
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `company_contacts_contact_idx` ON `company_contacts` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`emails` text DEFAULT '[]' NOT NULL,
	`phones` text DEFAULT '[]' NOT NULL,
	`address` text,
	`notes` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contacts_name_idx` ON `contacts` (`name`);--> statement-breakpoint
CREATE TABLE `installation_daily` (
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`day` text NOT NULL,
	`online_seconds` integer DEFAULT 0 NOT NULL,
	`active_seconds` integer DEFAULT 0 NOT NULL,
	`cpu_avg` real,
	`cpu_max` real,
	`cpu_p95` real,
	`memory_avg` real,
	`memory_max` real,
	`memory_p95` real,
	`gpu_avg` real,
	`gpu_max` real,
	`net_rx_bytes` integer DEFAULT 0 NOT NULL,
	`net_tx_bytes` integer DEFAULT 0 NOT NULL,
	`battery_min` real,
	`samples` integer DEFAULT 0 NOT NULL,
	`events` integer DEFAULT 0 NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`installation_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `installation_daily_app_day_idx` ON `installation_daily` (`app_id`,`day`);--> statement-breakpoint
CREATE TABLE `installations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`device_id` text NOT NULL,
	`alias` text,
	`platform` text NOT NULL,
	`os_name` text,
	`os_version` text,
	`arch` text,
	`hostname` text,
	`user_agent` text,
	`app_version` text,
	`previous_app_version` text,
	`channel` text DEFAULT 'stable' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`needs_review` integer DEFAULT true NOT NULL,
	`reviewed_at` integer,
	`reviewed_by` text,
	`state_override` text,
	`state_message` text,
	`enrolled_with_key_id` text,
	`enrolled_ip` text,
	`enrolled_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer,
	`last_ip` text,
	`last_snapshot` text,
	`access_token_hash` text,
	`access_token_expires_at` integer,
	`refresh_token_hash` text,
	`refresh_token_expires_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installations_app_device_unique` ON `installations` (`app_id`,`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `installations_access_token_unique` ON `installations` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `installations_refresh_token_unique` ON `installations` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `installations_app_seen_idx` ON `installations` (`app_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `installations_review_idx` ON `installations` (`needs_review`,`status`);--> statement-breakpoint
CREATE TABLE `metric_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`cpu_percent` real,
	`memory_used_bytes` integer,
	`memory_total_bytes` integer,
	`gpu_percent` real,
	`disk_used_bytes` integer,
	`disk_total_bytes` integer,
	`net_rx_bytes` integer,
	`net_tx_bytes` integer,
	`battery_percent` real,
	`battery_charging` integer,
	`power_watts` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metric_samples_installation_time_unique` ON `metric_samples` (`installation_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `metric_samples_recorded_idx` ON `metric_samples` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `usage_events` (
	`installation_id` text NOT NULL,
	`event_id` text NOT NULL,
	`app_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`session_id` text,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`properties` text,
	PRIMARY KEY(`installation_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `usage_events_installation_time_idx` ON `usage_events` (`installation_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `usage_events_occurred_idx` ON `usage_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `usage_hourly` (
	`installation_id` text NOT NULL,
	`app_id` text NOT NULL,
	`hour_start` integer NOT NULL,
	`online_seconds` integer DEFAULT 0 NOT NULL,
	`active_seconds` integer DEFAULT 0 NOT NULL,
	`heartbeats` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`installation_id`, `hour_start`)
);
--> statement-breakpoint
CREATE INDEX `usage_hourly_app_hour_idx` ON `usage_hourly` (`app_id`,`hour_start`);--> statement-breakpoint
CREATE INDEX `usage_hourly_hour_idx` ON `usage_hourly` (`hour_start`);--> statement-breakpoint
-- The audit trail is append-only, and that is enforced here rather than by convention: no route,
-- script or future refactor can rewrite or erase an entry while these two triggers exist. Hand-written
-- because drizzle-kit does not generate triggers; the snapshot does not describe them.
CREATE TRIGGER `audit_logs_no_update` BEFORE UPDATE ON `audit_logs`
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_logs_no_delete` BEFORE DELETE ON `audit_logs`
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;
