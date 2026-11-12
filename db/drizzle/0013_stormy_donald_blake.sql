CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`role` text NOT NULL,
	`environment_ids` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`revoked_at` text,
	`last_used_at` text,
	CONSTRAINT "api_keys_role" CHECK("role" in ('admin', 'runs')),
	CONSTRAINT "api_keys_environment_ids" CHECK(json_type("environment_ids") = 'array'),
	CONSTRAINT "api_keys_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "api_keys_revoked_at" CHECK("revoked_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "api_keys_last_used_at" CHECK("last_used_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
ALTER TABLE `agents` ADD `owner_key_id` text REFERENCES api_keys(id);--> statement-breakpoint
CREATE INDEX `agents_owner_key_id` ON `agents` (`owner_key_id`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `owner_key_id` text REFERENCES api_keys(id);