ALTER TABLE `environments` ADD `webhook_id` text REFERENCES webhooks(id) ON DELETE set null;
