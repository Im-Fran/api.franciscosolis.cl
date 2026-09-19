CREATE TABLE `application_release_files` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`update_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`checksum` text,
	`platform` text DEFAULT 'any' NOT NULL,
	`label` text,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`uploaded_at` integer,
	`download_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`update_id`) REFERENCES `application_updates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_release_files_update_filename_unique` ON `application_release_files` (`update_id`,`filename`);--> statement-breakpoint
CREATE INDEX `application_release_files_update_position_idx` ON `application_release_files` (`update_id`,`status`,`position`);--> statement-breakpoint
CREATE INDEX `application_release_files_application_idx` ON `application_release_files` (`application_id`);--> statement-breakpoint
CREATE TABLE `download_events` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`application_id` text NOT NULL,
	`application_slug` text NOT NULL,
	`update_id` text NOT NULL,
	`version` text NOT NULL,
	`filename` text NOT NULL,
	`user_id` text,
	`purchase_id` text,
	`paid` integer DEFAULT false NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `download_events_user_created_idx` ON `download_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `download_events_file_idx` ON `download_events` (`file_id`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'mercadopago' NOT NULL,
	`event_id` text NOT NULL,
	`topic` text,
	`payment_id` text,
	`purchase_id` text,
	`status` text,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_provider_event_unique` ON `payment_events` (`provider`,`event_id`);--> statement-breakpoint
CREATE INDEX `payment_events_purchase_idx` ON `payment_events` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`application_slug` text NOT NULL,
	`kind` text DEFAULT 'purchase' NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CLP' NOT NULL,
	`provider` text DEFAULT 'mercadopago' NOT NULL,
	`preference_id` text,
	`payment_id` text,
	`external_reference` text NOT NULL,
	`approved_at` integer,
	`refunded_at` integer,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_external_reference_unique` ON `purchases` (`external_reference`);--> statement-breakpoint
CREATE INDEX `purchases_application_user_idx` ON `purchases` (`application_id`,`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `purchases_user_created_idx` ON `purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_payment_idx` ON `purchases` (`payment_id`);--> statement-breakpoint
CREATE INDEX `purchases_status_created_idx` ON `purchases` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `applications` ADD `pricing_mode` text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `price_amount` integer;--> statement-breakpoint
ALTER TABLE `applications` ADD `suggested_amount` integer;