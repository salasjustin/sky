PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`summary` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`turns` integer,
	`duration_ms` integer,
	`rollup` text,
	`secret_names` text,
	`claude_credential` text,
	`retry_of` text,
	`launch_ciphertext` blob,
	`launch_nonce` blob,
	`launch_key_version` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "runs_status" CHECK("status" in ('queued', 'starting', 'running', 'waiting', 'finished', 'failed', 'stopped')),
	CONSTRAINT "runs_usage" CHECK(("input_tokens" is null and "output_tokens" is null and "cost_usd" is null and "turns" is null and "duration_ms" is null)
        or ("input_tokens" >= 0 and "output_tokens" >= 0 and "cost_usd" >= 0 and "turns" >= 0 and "duration_ms" >= 0)),
	CONSTRAINT "runs_created_at" CHECK("created_at" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "agent_id", "status", "summary", "input_tokens", "output_tokens", "cost_usd", "turns", "duration_ms", "rollup", "secret_names", "claude_credential", "retry_of", "launch_ciphertext", "launch_nonce", "launch_key_version", "created_at") SELECT "id", "agent_id", "status", "summary", "input_tokens", "output_tokens", "cost_usd", "turns", "duration_ms", "rollup", "secret_names", "claude_credential", "retry_of", "launch_ciphertext", "launch_nonce", "launch_key_version", "created_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `runs_agent_id_created_at` ON `runs` (`agent_id`,`created_at`);