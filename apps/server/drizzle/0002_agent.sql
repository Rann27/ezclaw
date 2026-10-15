CREATE TABLE `approval_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace` text NOT NULL,
	`pattern` text NOT NULL,
	`pattern_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approval_rules_unique_idx` ON `approval_rules` (`workspace`,`pattern_key`);--> statement-breakpoint
CREATE TABLE `harness_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `raw` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `workspace` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `approval_mode` text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `harness` text DEFAULT '{"on":true,"profileId":"ezclaw-agent","tools":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `plan` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `summary_seq` integer DEFAULT 0 NOT NULL;