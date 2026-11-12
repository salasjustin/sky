CREATE TABLE `claude_usage` (
	`credential` text PRIMARY KEY NOT NULL,
	`five_hour_utilization` real,
	`five_hour_resets_at` text,
	`seven_day_utilization` real,
	`seven_day_resets_at` text,
	`probed_at` text NOT NULL,
	CONSTRAINT "claude_usage_probed_at" CHECK("probed_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
ALTER TABLE `environments` ADD `claude_pool` text;