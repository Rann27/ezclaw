CREATE TABLE `endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`preset_id` text NOT NULL,
	`family` text,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`auth_type` text NOT NULL,
	`auth_header` text,
	`extra_headers` text DEFAULT '{}' NOT NULL,
	`key_last4` text,
	`last_test_at` integer,
	`last_test_ok` integer,
	`last_test_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`notes` text DEFAULT '[]' NOT NULL,
	`usage` text,
	`finish_reason` text,
	`model_label` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_thread_seq_idx` ON `messages` (`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`model_id` text NOT NULL,
	`name` text NOT NULL,
	`alias` text,
	`favorite` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`kind` text DEFAULT 'text' NOT NULL,
	`discovered_patch` text DEFAULT '{}' NOT NULL,
	`override` text,
	`omit` text DEFAULT '[]' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`discovered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_endpoint_model_idx` ON `models` (`endpoint_id`,`model_id`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`method` text NOT NULL,
	`url` text NOT NULL,
	`request_headers` text NOT NULL,
	`request_body` text NOT NULL,
	`status` integer,
	`response_text` text,
	`error` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `request_logs_message_idx` ON `request_logs` (`message_id`);--> statement-breakpoint
CREATE INDEX `request_logs_started_idx` ON `request_logs` (`started_at`);--> statement-breakpoint
ALTER TABLE `threads` ADD `model_row_id` text REFERENCES models(id);--> statement-breakpoint
ALTER TABLE `threads` ADD `system_prompt` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `params` text DEFAULT '{}' NOT NULL;