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
CREATE INDEX `audit_logs_actor_email_idx` ON `audit_logs` (`actor_email`);--> statement-breakpoint
CREATE TABLE `content_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`collection` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`summary` text,
	`body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`url` text,
	`image_url` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_entries_collection_slug_unique` ON `content_entries` (`collection`,`slug`);--> statement-breakpoint
CREATE INDEX `content_entries_collection_status_idx` ON `content_entries` (`collection`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `email_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`to_addresses` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text,
	`reply_to` text,
	`subject` text NOT NULL,
	`html` text,
	`text` text,
	`template_slug` text,
	`status` text NOT NULL,
	`message_id` text,
	`error` text,
	`sent_by` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_messages_created_at_idx` ON `email_messages` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_messages_status_idx` ON `email_messages` (`status`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`subject` text NOT NULL,
	`html` text,
	`text` text,
	`variables` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_slug_unique` ON `email_templates` (`slug`);--> statement-breakpoint
CREATE TABLE `legal_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` text,
	`effective_at` integer,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_pages_slug_unique` ON `legal_pages` (`slug`);