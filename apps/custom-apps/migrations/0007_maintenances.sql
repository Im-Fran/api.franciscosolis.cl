-- Scheduled maintenances: the maintenance, the windows it is offered in and the approval links sent
-- to the client; a security patch horizon on contracts; and the work log entry a maintenance logged.
-- Hand-edited: drizzle-kit dropped `ON DELETE set null` from the `work_logs.maintenance_id` column it
-- adds (the snapshot has it). SQLite accepts a REFERENCES clause on ADD COLUMN when the default is
-- NULL, so the column is added in place with the action the schema declares, and no table is rebuilt.
CREATE TABLE `maintenance_links` (
	`id` text PRIMARY KEY NOT NULL,
	`maintenance_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`recipient_email` text NOT NULL,
	`send` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`invalidated_at` integer,
	`answer` text,
	`answered_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`maintenance_id`) REFERENCES `maintenances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_links_token_unique` ON `maintenance_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `maintenance_links_maintenance_idx` ON `maintenance_links` (`maintenance_id`,`send`);--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`maintenance_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`maintenance_id`) REFERENCES `maintenances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maintenance_windows_maintenance_idx` ON `maintenance_windows` (`maintenance_id`,`position`);--> statement-breakpoint
CREATE TABLE `maintenances` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`company_id` text NOT NULL,
	`kind` text DEFAULT 'normal' NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`estimated_minutes` integer NOT NULL,
	`release_id` text,
	`installation_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`sends` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer,
	`chosen_window_id` text,
	`scheduled_at` integer,
	`auto_applied` integer DEFAULT false NOT NULL,
	`responded_by` text,
	`responded_by_name` text,
	`responded_at` integer,
	`rejection_reason` text,
	`rejected_at` integer,
	`reminder_sent_at` integer,
	`result` text,
	`result_detail` text DEFAULT '{}' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`closed_by` text,
	`work_log_id` text,
	`cancelled_at` integer,
	`cancelled_by` text,
	`cancel_reason` text,
	`created_by_id` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `maintenances_status_idx` ON `maintenances` (`status`);--> statement-breakpoint
CREATE INDEX `maintenances_app_idx` ON `maintenances` (`app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `maintenances_company_idx` ON `maintenances` (`company_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `contracts` ADD `security_patch_days` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `work_logs` ADD `maintenance_id` text REFERENCES maintenances(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `work_logs_maintenance_idx` ON `work_logs` (`maintenance_id`);