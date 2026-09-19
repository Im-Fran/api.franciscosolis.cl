CREATE TABLE `sale_vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`purchase_id` text NOT NULL,
	`application_id` text NOT NULL,
	`application_slug` text NOT NULL,
	`application_name` text NOT NULL,
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
CREATE INDEX `sale_vouchers_application_issued_idx` ON `sale_vouchers` (`application_id`,`status`,`issued_at`);--> statement-breakpoint
CREATE INDEX `sale_vouchers_email_idx` ON `sale_vouchers` (`email`);--> statement-breakpoint
ALTER TABLE `purchases` ADD `source` text DEFAULT 'mercadopago' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `environment` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `purchases` ADD `refunded_amount` integer;--> statement-breakpoint
ALTER TABLE `purchases` ADD `refund_reason` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `refunded_by` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `refund_id` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `note` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `created_by` text;--> statement-breakpoint
CREATE INDEX `purchases_application_created_idx` ON `purchases` (`application_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchases_email_idx` ON `purchases` (`email`);