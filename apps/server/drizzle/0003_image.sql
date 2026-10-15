CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`file` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assets_sha_idx` ON `assets` (`sha256`);--> statement-breakpoint
ALTER TABLE `threads` ADD `image_params` text DEFAULT '{}' NOT NULL;