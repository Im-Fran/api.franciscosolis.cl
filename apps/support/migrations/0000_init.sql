CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`actor_email` text,
	`ticket_id` text,
	`input_chars` integer DEFAULT 0 NOT NULL,
	`output_chars` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_requests_created_idx` ON `ai_requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_requests_actor_created_idx` ON `ai_requests` (`actor_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_requests_kind_created_idx` ON `ai_requests` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`actor_email` text,
	`actor_id` text,
	`resource_type` text,
	`resource_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_email`);--> statement-breakpoint
CREATE INDEX `audit_logs_resource_idx` ON `audit_logs` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `email_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text,
	`kind` text NOT NULL,
	`to_addresses` text NOT NULL,
	`from_email` text NOT NULL,
	`from_name` text,
	`reply_to` text,
	`subject` text NOT NULL,
	`html` text,
	`text` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_message_id` text,
	`rfc_message_id` text,
	`error` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_messages_ticket_idx` ON `email_messages` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `email_messages_provider_id_idx` ON `email_messages` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `email_messages_rfc_id_idx` ON `email_messages` (`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `email_messages_created_idx` ON `email_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `help_article_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`helpful` integer NOT NULL,
	`comment` text,
	`fingerprint_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `help_articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_article_feedback_article_fingerprint_unique` ON `help_article_feedback` (`article_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE INDEX `help_article_feedback_article_created_idx` ON `help_article_feedback` (`article_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `help_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`vector_ids` text DEFAULT '[]' NOT NULL,
	`search_indexed_at` integer,
	`helpful_yes` integer DEFAULT 0 NOT NULL,
	`helpful_no` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `help_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_articles_slug_unique` ON `help_articles` (`slug`);--> statement-breakpoint
CREATE INDEX `help_articles_status_position_idx` ON `help_articles` (`status`,`position`);--> statement-breakpoint
CREATE INDEX `help_articles_category_position_idx` ON `help_articles` (`category_id`,`position`);--> statement-breakpoint
CREATE TABLE `help_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `help_categories_slug_unique` ON `help_categories` (`slug`);--> statement-breakpoint
CREATE INDEX `help_categories_status_position_idx` ON `help_categories` (`status`,`position`);--> statement-breakpoint
CREATE TABLE `help_search_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`result_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `help_search_queries_created_idx` ON `help_search_queries` (`created_at`);--> statement-breakpoint
CREATE TABLE `inbound_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id_hash` text NOT NULL,
	`message_id` text,
	`from_email` text NOT NULL,
	`to_email` text NOT NULL,
	`subject` text,
	`raw_size` integer DEFAULT 0 NOT NULL,
	`ticket_id` text,
	`ticket_message_id` text,
	`match_strategy` text,
	`outcome` text NOT NULL,
	`reject_reason` text,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`ai_ok` integer,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_emails_message_id_hash_unique` ON `inbound_emails` (`message_id_hash`);--> statement-breakpoint
CREATE INDEX `inbound_emails_from_received_idx` ON `inbound_emails` (`from_email`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbound_emails_ticket_idx` ON `inbound_emails` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`position` integer DEFAULT 0 NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_slug_unique` ON `labels` (`slug`);--> statement-breakpoint
CREATE INDEX `labels_position_idx` ON `labels` (`position`);--> statement-breakpoint
CREATE TABLE `support_counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ticket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`event` text NOT NULL,
	`actor_type` text DEFAULT 'system' NOT NULL,
	`actor_email` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_created_idx` ON `ticket_events` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_labels` (
	`ticket_id` text NOT NULL,
	`label_id` text NOT NULL,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`ticket_id`, `label_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_labels_label_idx` ON `ticket_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text DEFAULT 'reply' NOT NULL,
	`author_type` text NOT NULL,
	`author_email` text,
	`author_name` text,
	`author_user_id` text,
	`body_text` text NOT NULL,
	`body_text_raw` text,
	`source` text DEFAULT 'web' NOT NULL,
	`attachments_meta` text DEFAULT '[]' NOT NULL,
	`edited_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_messages_ticket_seq_unique` ON `ticket_messages` (`ticket_id`,`seq`);--> statement-breakpoint
CREATE INDEX `ticket_messages_ticket_created_idx` ON `ticket_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`due_at` integer NOT NULL,
	`after_seq` integer DEFAULT 0 NOT NULL,
	`through_seq` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`claimed_at` integer,
	`sent_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_notifications_state_due_idx` ON `ticket_notifications` (`state`,`due_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_notifications_pending_unique` ON `ticket_notifications` (`ticket_id`,`recipient_email`) WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX `ticket_notifications_ticket_idx` ON `ticket_notifications` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `ticket_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`user_id` text,
	`role` text DEFAULT 'cc' NOT NULL,
	`notify_email` integer DEFAULT true NOT NULL,
	`last_notified_seq` integer DEFAULT 0 NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`added_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_participants_ticket_email_unique` ON `ticket_participants` (`ticket_id`,`email`);--> statement-breakpoint
CREATE INDEX `ticket_participants_email_idx` ON `ticket_participants` (`email`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`requester_email` text NOT NULL,
	`requester_name` text,
	`requester_user_id` text,
	`assignee_email` text,
	`assignee_user_id` text,
	`access_token_hash` text NOT NULL,
	`access_token_rotated_at` integer,
	`reply_key` text NOT NULL,
	`last_message_seq` integer DEFAULT 0 NOT NULL,
	`last_requester_message_at` integer,
	`last_agent_message_at` integer,
	`first_response_at` integer,
	`solved_at` integer,
	`closed_at` integer,
	`ai_enriched` integer DEFAULT false NOT NULL,
	`ai_model` text,
	`ai_summary` text,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_number_unique` ON `tickets` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_access_token_hash_unique` ON `tickets` (`access_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_reply_key_unique` ON `tickets` (`reply_key`);--> statement-breakpoint
CREATE INDEX `tickets_status_updated_idx` ON `tickets` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `tickets_assignee_status_idx` ON `tickets` (`assignee_email`,`status`);--> statement-breakpoint
CREATE INDEX `tickets_requester_email_idx` ON `tickets` (`requester_email`);--> statement-breakpoint
CREATE INDEX `tickets_requester_user_idx` ON `tickets` (`requester_user_id`);--> statement-breakpoint
-- The help centre's lexical search index. Drizzle cannot model an FTS5 virtual table, so it is
-- appended here by hand rather than generated. That is deliberate and safe: drizzle diffs
-- `src/db/schema.ts` against `meta/0000_snapshot.json` and never against the live database, so a
-- table present in neither is invisible to it forever and no future `generate` will emit a DROP for
-- it. A *later* change to this table needs its own hand-written migration, an entry appended to
-- `meta/_journal.json`, and a copy of the previous snapshot renumbered beside it — see CLAUDE.md.
--
-- One row per (article, locale): the bilingual model stores Spanish as an override blob on the
-- article row, and a search index has to hold the resolved text, not the override.
--
-- `remove_diacritics 2` rather than `1`: version 1 does not handle diacritics that occupy more than
-- one code point, which is the difference between `facturacion` finding `facturación` and not.
-- `prefix` pre-builds the 2- and 3-character prefix indexes the type-ahead's `"term"*` queries need.
CREATE VIRTUAL TABLE `help_search` USING fts5(
  article_id UNINDEXED,
  locale UNINDEXED,
  slug UNINDEXED,
  title,
  summary,
  body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);--> statement-breakpoint
-- A safety net, not the normal path. `src/services/help-search.ts` clears these rows itself on every
-- write, because the per-locale rows are derived from a JSON blob whose field names live in
-- `src/lib/locales.ts` and re-expressing that in SQL would duplicate the list somewhere TypeScript
-- cannot check. What application code cannot cover is a row removed some other way — a cascade, or a
-- hand-run DELETE during an incident — because a foreign key cannot reach into a virtual table.
CREATE TRIGGER `help_articles_delete_search` AFTER DELETE ON `help_articles` BEGIN
  DELETE FROM `help_search` WHERE `article_id` = old.`id`;
END;
