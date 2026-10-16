CREATE TABLE `file_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`run_message_id` text NOT NULL,
	`path` text NOT NULL,
	`existed` integer NOT NULL,
	`content` blob,
	`restored_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_snapshots_run_path_idx` ON `file_snapshots` (`run_message_id`,`path`);--> statement-breakpoint
CREATE INDEX `file_snapshots_thread_idx` ON `file_snapshots` (`thread_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`scope` text NOT NULL,
	`workspace` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`thread_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `memories_status_idx` ON `memories` (`status`);