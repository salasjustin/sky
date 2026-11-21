ALTER TABLE `webhook_deliveries` ADD `last_attempt_at` text;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_id_last_attempt_at` ON `webhook_deliveries` (`webhook_id`,`last_attempt_at`);--> statement-breakpoint
ALTER TABLE `webhooks` ADD `failing_since` text;--> statement-breakpoint
-- a delivered or failed row's next_attempt_at was never moved past its final attempt, so it is when that attempt ran
UPDATE `webhook_deliveries` SET `last_attempt_at` = `next_attempt_at` WHERE `status` in ('delivered', 'failed') AND `attempts` > 0;--> statement-breakpoint
-- a webhook whose newest finished delivery gave up is failing since then
UPDATE `webhooks` SET `failing_since` = (
  SELECT max(`d`.`last_attempt_at`) FROM `webhook_deliveries` `d`
  WHERE `d`.`webhook_id` = `webhooks`.`id` AND `d`.`status` = 'failed'
)
WHERE EXISTS (
  SELECT 1 FROM `webhook_deliveries` `f`
  WHERE `f`.`webhook_id` = `webhooks`.`id` AND `f`.`status` = 'failed'
    AND NOT EXISTS (
      SELECT 1 FROM `webhook_deliveries` `ok`
      WHERE `ok`.`webhook_id` = `webhooks`.`id` AND `ok`.`status` = 'delivered'
        AND `ok`.`last_attempt_at` > `f`.`last_attempt_at`
    )
);