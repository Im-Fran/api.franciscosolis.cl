CREATE TABLE `contract_apps` (
	`contract_id` text NOT NULL,
	`app_id` text NOT NULL,
	PRIMARY KEY(`contract_id`, `app_id`),
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contract_apps_app_idx` ON `contract_apps` (`app_id`);--> statement-breakpoint
CREATE TABLE `contract_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`contract_id` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`included_minutes` integer NOT NULL,
	`carried` text DEFAULT '[]' NOT NULL,
	`carried_minutes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`used_minutes` integer,
	`overage_minutes` integer,
	`overage_amount` real,
	`expired_minutes` integer,
	`closed_at` integer,
	`closed_by` text,
	`billed_at` integer,
	`billed_by` text,
	`billing_reference` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contract_cycles_contract_start_unique` ON `contract_cycles` (`contract_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `contract_cycles_status_idx` ON `contract_cycles` (`status`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`name` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'CLP' NOT NULL,
	`billing_period` text DEFAULT 'monthly' NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`auto_renew` integer DEFAULT false NOT NULL,
	`renewal_months` integer DEFAULT 12 NOT NULL,
	`notice_days` integer DEFAULT 30 NOT NULL,
	`cycle_period` text DEFAULT 'monthly' NOT NULL,
	`included_minutes` integer DEFAULT 0 NOT NULL,
	`rollover_enabled` integer DEFAULT false NOT NULL,
	`rollover_max_minutes` integer,
	`rollover_max_cycles` integer,
	`overage_rate` real DEFAULT 0 NOT NULL,
	`grace_days` integer DEFAULT 0 NOT NULL,
	`grace_allows` text DEFAULT '[]' NOT NULL,
	`grace_message` text,
	`notice_sent_at` integer,
	`lapsed_at` integer,
	`cancelled_at` integer,
	`cancelled_by` text,
	`notes` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `contracts_company_idx` ON `contracts` (`company_id`);--> statement-breakpoint
CREATE INDEX `contracts_ends_idx` ON `contracts` (`ends_on`);--> statement-breakpoint
CREATE TABLE `ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author` text NOT NULL,
	`author_name` text,
	`author_email` text,
	`body` text NOT NULL,
	`seen_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_messages_ticket_idx` ON `ticket_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`app_id` text NOT NULL,
	`company_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`requester_name` text,
	`requester_email` text,
	`context` text DEFAULT '{}' NOT NULL,
	`last_message_at` integer NOT NULL,
	`last_message_by` text DEFAULT 'requester' NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_number_unique` ON `tickets` (`number`);--> statement-breakpoint
CREATE INDEX `tickets_status_activity_idx` ON `tickets` (`status`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `tickets_app_idx` ON `tickets` (`app_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `tickets_installation_idx` ON `tickets` (`installation_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `work_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`app_id` text,
	`contract_id` text,
	`cycle_id` text,
	`occurred_on` text NOT NULL,
	`minutes` integer NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`link_url` text,
	`ticket_id` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contract_id`) REFERENCES `contracts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cycle_id`) REFERENCES `contract_cycles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `work_logs_company_day_idx` ON `work_logs` (`company_id`,`occurred_on`);--> statement-breakpoint
CREATE INDEX `work_logs_app_day_idx` ON `work_logs` (`app_id`,`occurred_on`);--> statement-breakpoint
CREATE INDEX `work_logs_cycle_idx` ON `work_logs` (`cycle_id`);--> statement-breakpoint
ALTER TABLE `apps` ADD `support_assignee_id` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `support_assignee_email` text;