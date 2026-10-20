-- Alerts outlive their app as they outlive their rule: `app_id` was never a foreign key, but the
-- panel took the app's name from a join that finds nothing once the app is deleted. The name is now
-- snapshotted onto each alert, and the alerts already stored take it from their app while it exists.
ALTER TABLE `alerts` ADD `app_name` text;--> statement-breakpoint
UPDATE `alerts` SET `app_name` = (SELECT `name` FROM `apps` WHERE `apps`.`id` = `alerts`.`app_id`);
