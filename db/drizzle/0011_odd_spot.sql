PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type" CHECK("type" in ('run.started', 'run.waiting', 'run.finished', 'run.failed', 'run.stopped', 'run.resumed',
        'run.probed', 'runner.warning',
        'claude.PreToolUse', 'claude.PostToolUse', 'claude.PostToolUseFailure', 'claude.SubagentStart', 'claude.SubagentStop',
        'claude.TaskCreated', 'claude.TaskCompleted', 'claude.Notification', 'claude.PreCompact', 'claude.FileChanged', 'claude.Message')),
	CONSTRAINT "events_ts" CHECK("ts" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'),
	CONSTRAINT "events_payload" CHECK(json_type("payload") = 'object')
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_events`("id", "run_id", "ts", "type", "payload") SELECT "id", "run_id", "ts", "type", "payload" FROM `events`;--> statement-breakpoint
-- hand-added: the copy resets AUTOINCREMENT to max(id), which would reuse ids deleted from the tail (they are SSE Last-Event-IDs)
DELETE FROM sqlite_sequence WHERE name = '__new_events';--> statement-breakpoint
INSERT INTO sqlite_sequence(name, seq) SELECT '__new_events', seq FROM sqlite_sequence WHERE name = 'events';--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_run_id_id` ON `events` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_claude_ts` ON `events` (`ts`) WHERE "type" glob 'claude.*';