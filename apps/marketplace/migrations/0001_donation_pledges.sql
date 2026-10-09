-- What a donor chose to give, beside the pesos they were charged: a general donation can be named in
-- dollars, euros and so on, and is settled in CLP at the day's rate (apps/marketplace/src/lib/donations.ts).
-- Purely additive, like every migration on `purchases`: a rebuild would race the production deploy.
ALTER TABLE `purchases` ADD `pledged_amount` integer;--> statement-breakpoint
ALTER TABLE `purchases` ADD `pledged_currency` text;--> statement-breakpoint
ALTER TABLE `sale_vouchers` ADD `pledged_amount` integer;--> statement-breakpoint
ALTER TABLE `sale_vouchers` ADD `pledged_currency` text;
