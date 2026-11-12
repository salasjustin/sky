CREATE TABLE `claude_limits` (
	`credential` text PRIMARY KEY NOT NULL,
	`limited_until` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "claude_limits_limited_until" CHECK("limited_until" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "claude_limits_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
ALTER TABLE `environments` ADD `claude_credential` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `claude_fallback` text DEFAULT 'api-key' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `claude_credential` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `retry_of` text;