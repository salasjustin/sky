ALTER TABLE `runs` ADD `launch_ciphertext` blob;--> statement-breakpoint
ALTER TABLE `runs` ADD `launch_nonce` blob;--> statement-breakpoint
ALTER TABLE `runs` ADD `launch_key_version` integer;