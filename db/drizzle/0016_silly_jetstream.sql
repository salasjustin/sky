PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`event_types` text NOT NULL,
	`format` text DEFAULT 'sky' NOT NULL,
	`secret_ciphertext` blob,
	`secret_nonce` blob,
	`secret_key_version` integer,
	`environment_ids` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`owner_key_id` text,
	FOREIGN KEY (`owner_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhooks_event_types" CHECK(json_type("event_types") = 'array' and json_array_length("event_types") > 0),
	CONSTRAINT "webhooks_format" CHECK("format" in ('sky', 'standard', 'openbot')),
	CONSTRAINT "webhooks_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_webhooks`("id", "url", "event_types", "format", "secret_ciphertext", "secret_nonce", "secret_key_version", "environment_ids", "created_at", "owner_key_id") SELECT "id", "url", "event_types", "format", "secret_ciphertext", "secret_nonce", "secret_key_version", "environment_ids", "created_at", "owner_key_id" FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;