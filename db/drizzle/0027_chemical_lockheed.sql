ALTER TABLE `agents` ADD `rebuilt_at` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `health` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `health_error` text;--> statement-breakpoint
ALTER TABLE `environments` ADD `health_at` text;