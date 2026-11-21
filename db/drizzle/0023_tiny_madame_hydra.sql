ALTER TABLE `webhook_deliveries` ADD `last_attempt_at` text;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_id_last_attempt_at` ON `webhook_deliveries` (`webhook_id`,`last_attempt_at`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `failing_since` text;--> statement-breakpoint
-- a delivered or failed row's next_attempt_at was never moved past its final attempt, so it is when that attempt was due, not exactly when it ran
UPDATE `webhook_deliveries` SET `last_attempt_at` = `next_attempt_at` WHERE `status` in ('delivered', 'failed') AND `attempts` > 0;--> statement-breakpoint
-- failing since the first give-up after the latest delivery, as markFailing in apps/api/src/deliveries.ts keeps it; no such give-up leaves it null
UPDATE `webhooks` SET `failing_since` = (
  SELECT min(`f`.`last_attempt_at`) FROM `webhook_deliveries` `f`
  WHERE `f`.`webhook_id` = `webhooks`.`id` AND `f`.`status` = 'failed'
    AND `f`.`last_attempt_at` > coalesce((
      SELECT max(`ok`.`last_attempt_at`) FROM `webhook_deliveries` `ok`
      WHERE `ok`.`webhook_id` = `webhooks`.`id` AND `ok`.`status` = 'delivered'
    ), '')
);