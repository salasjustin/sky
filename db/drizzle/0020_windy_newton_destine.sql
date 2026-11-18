CREATE TABLE `previews` (
	`env_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`port` integer NOT NULL,
	`build_cmd` text,
	`start_cmd` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`failure` text,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`env_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "previews_port" CHECK("port" between 1 and 65535),
	CONSTRAINT "previews_state" CHECK("state" in ('building', 'starting', 'ready', 'failed')),
	CONSTRAINT "previews_failure" CHECK(("state" = 'failed') = ("failure" is not null)),
	CONSTRAINT "previews_expires_at" CHECK("expires_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "previews_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
CREATE INDEX `previews_agent_id` ON `previews` (`agent_id`);