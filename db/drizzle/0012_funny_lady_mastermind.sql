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
	CONSTRAINT "webhooks_event_types" CHECK(json_type("event_types") = 'array' and json_array_length("event_types") > 0),
	CONSTRAINT "webhooks_format" CHECK("format" in ('sky', 'standard')),
	CONSTRAINT "webhooks_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
-- hand-added: drizzle-kit selects the new columns from the old table; they take their defaults (format 'sky', the rest null)
INSERT INTO `__new_webhooks`("id", "url", "event_types", "created_at") SELECT "id", "url", "event_types", "created_at" FROM `webhooks`;--> statement-breakpoint
DROP TABLE `webhooks`;--> statement-breakpoint
ALTER TABLE `__new_webhooks` RENAME TO `webhooks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;