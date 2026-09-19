CREATE TABLE `ai_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`actor_email` text,
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
	`ip` text,
	`user_agent` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_email_idx` ON `audit_logs` (`actor_email`);--> statement-breakpoint
CREATE TABLE `download_events` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_slug` text NOT NULL,
	`release_id` text NOT NULL,
	`version` text NOT NULL,
	`channel` text DEFAULT 'release' NOT NULL,
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
CREATE INDEX `download_events_product_user_idx` ON `download_events` (`product_id`,`user_id`);--> statement-breakpoint
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
CREATE TABLE `product_daily_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`release_id` text DEFAULT '' NOT NULL,
	`day` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`downloads` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_daily_stats_day_unique` ON `product_daily_stats` (`product_id`,`release_id`,`day`);--> statement-breakpoint
CREATE INDEX `product_daily_stats_product_day_idx` ON `product_daily_stats` (`product_id`,`day`);--> statement-breakpoint
CREATE TABLE `product_release_compatibility` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`release_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`constraint_text` text,
	`optional` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `product_releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_release_compatibility_release_kind_name_unique` ON `product_release_compatibility` (`release_id`,`kind`,`name`);--> statement-breakpoint
CREATE INDEX `product_release_compatibility_release_position_idx` ON `product_release_compatibility` (`release_id`,`position`);--> statement-breakpoint
CREATE INDEX `product_release_compatibility_kind_name_idx` ON `product_release_compatibility` (`kind`,`name`);--> statement-breakpoint
CREATE TABLE `product_release_files` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`release_id` text NOT NULL,
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
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `product_releases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_release_files_release_filename_unique` ON `product_release_files` (`release_id`,`filename`);--> statement-breakpoint
CREATE INDEX `product_release_files_release_position_idx` ON `product_release_files` (`release_id`,`status`,`position`);--> statement-breakpoint
CREATE INDEX `product_release_files_product_idx` ON `product_release_files` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`version` text NOT NULL,
	`channel` text DEFAULT 'release' NOT NULL,
	`resets_rating` integer DEFAULT false NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
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
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_releases_product_channel_version_unique` ON `product_releases` (`product_id`,`channel`,`version`);--> statement-breakpoint
CREATE INDEX `product_releases_product_channel_released_idx` ON `product_releases` (`product_id`,`channel`,`status`,`released_at`);--> statement-breakpoint
CREATE INDEX `product_releases_rating_reset_idx` ON `product_releases` (`product_id`,`status`,`resets_rating`,`published_at`);--> statement-breakpoint
CREATE TABLE `product_review_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`product_id` text NOT NULL,
	`reporter_user_id` text NOT NULL,
	`reporter_email` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`resolution_note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `product_reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_review_reports_review_reporter_unique` ON `product_review_reports` (`review_id`,`reporter_user_id`);--> statement-breakpoint
CREATE INDEX `product_review_reports_status_created_idx` ON `product_review_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `product_review_reports_product_idx` ON `product_review_reports` (`product_id`,`status`);--> statement-breakpoint
CREATE TABLE `product_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`release_id` text,
	`release_version` text,
	`release_channel` text,
	`anchored_at` integer DEFAULT (unixepoch()) NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`author_name` text,
	`rating` integer NOT NULL,
	`title` text,
	`body` text,
	`status` text DEFAULT 'visible' NOT NULL,
	`hidden_at` integer,
	`hidden_by` text,
	`hidden_reason` text,
	`report_count` integer DEFAULT 0 NOT NULL,
	`reply_body` text,
	`reply_by` text,
	`reply_at` integer,
	`reply_updated_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_id`) REFERENCES `product_releases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_reviews_product_user_unique` ON `product_reviews` (`product_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `product_reviews_product_status_anchored_idx` ON `product_reviews` (`product_id`,`status`,`anchored_at`);--> statement-breakpoint
CREATE INDEX `product_reviews_release_idx` ON `product_reviews` (`release_id`,`status`);--> statement-breakpoint
CREATE INDEX `product_reviews_user_created_idx` ON `product_reviews` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `product_reviews_reports_idx` ON `product_reviews` (`report_count`,`status`);--> statement-breakpoint
CREATE TABLE `product_wiki_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
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
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_wiki_pages_product_slug_unique` ON `product_wiki_pages` (`product_id`,`slug`);--> statement-breakpoint
CREATE INDEX `product_wiki_pages_product_position_idx` ON `product_wiki_pages` (`product_id`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `products` (
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
	`pricing_mode` text DEFAULT 'free' NOT NULL,
	`price_amount` integer,
	`suggested_amount` integer,
	`pre_release_requires_purchase` integer DEFAULT false NOT NULL,
	`category` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`download_count` integer DEFAULT 0 NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_unique` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_status_position_idx` ON `products` (`status`,`position`);--> statement-breakpoint
CREATE INDEX `products_category_status_idx` ON `products` (`category`,`status`,`position`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`product_slug` text NOT NULL,
	`kind` text DEFAULT 'purchase' NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CLP' NOT NULL,
	`provider` text DEFAULT 'mercadopago' NOT NULL,
	`source` text DEFAULT 'mercadopago' NOT NULL,
	`environment` text DEFAULT 'live' NOT NULL,
	`preference_id` text,
	`payment_id` text,
	`external_reference` text NOT NULL,
	`approved_at` integer,
	`refunded_at` integer,
	`refunded_amount` integer,
	`refund_reason` text,
	`refunded_by` text,
	`refund_id` text,
	`charged_back_at` integer,
	`chargeback_id` text,
	`note` text,
	`created_by` text,
	`metadata` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_external_reference_unique` ON `purchases` (`external_reference`);--> statement-breakpoint
CREATE INDEX `purchases_product_user_idx` ON `purchases` (`product_id`,`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `purchases_user_created_idx` ON `purchases` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_payment_idx` ON `purchases` (`payment_id`);--> statement-breakpoint
CREATE INDEX `purchases_status_created_idx` ON `purchases` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_product_created_idx` ON `purchases` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_email_idx` ON `purchases` (`email`);--> statement-breakpoint
CREATE TABLE `sale_vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`purchase_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_slug` text NOT NULL,
	`product_name` text NOT NULL,
	`email` text NOT NULL,
	`kind` text DEFAULT 'purchase' NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CLP' NOT NULL,
	`source` text DEFAULT 'mercadopago' NOT NULL,
	`status` text DEFAULT 'issued' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`issued_by` text,
	`issued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`voided_at` integer,
	`voided_by` text,
	`void_reason` text,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`last_sent_at` integer,
	`last_sent_to` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sale_vouchers_number_unique` ON `sale_vouchers` (`number`);--> statement-breakpoint
CREATE INDEX `sale_vouchers_purchase_idx` ON `sale_vouchers` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `sale_vouchers_product_issued_idx` ON `sale_vouchers` (`product_id`,`status`,`issued_at`);--> statement-breakpoint
CREATE INDEX `sale_vouchers_email_idx` ON `sale_vouchers` (`email`);