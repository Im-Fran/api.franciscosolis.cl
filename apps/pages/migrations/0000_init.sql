CREATE TABLE `application_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`version` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`released_at` integer,
	`links` text DEFAULT '[]' NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_updates_application_version_unique` ON `application_updates` (`application_id`,`version`);--> statement-breakpoint
CREATE INDEX `application_updates_application_released_idx` ON `application_updates` (`application_id`,`status`,`released_at`);--> statement-breakpoint
CREATE TABLE `application_wiki_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`icon` text,
	`body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_wiki_pages_application_slug_unique` ON `application_wiki_pages` (`application_id`,`slug`);--> statement-breakpoint
CREATE INDEX `application_wiki_pages_application_position_idx` ON `application_wiki_pages` (`application_id`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text,
	`summary` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`banner_image_url` text,
	`icon_image_url` text,
	`accent_color` text,
	`tabs` text DEFAULT '["overview"]' NOT NULL,
	`links` text DEFAULT '[]' NOT NULL,
	`overview_body` text,
	`contact_body` text,
	`translations` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_slug_unique` ON `applications` (`slug`);--> statement-breakpoint
CREATE INDEX `applications_status_position_idx` ON `applications` (`status`,`position`);--> statement-breakpoint
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
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_email_idx` ON `audit_logs` (`actor_email`);