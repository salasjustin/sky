DROP INDEX `runs_agent_id`;--> statement-breakpoint
CREATE INDEX `runs_agent_id_created_at` ON `runs` (`agent_id`,`created_at`);