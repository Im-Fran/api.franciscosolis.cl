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
CREATE INDEX `ai_requests_kind_created_idx` ON `ai_requests` (`kind`,`created_at`);