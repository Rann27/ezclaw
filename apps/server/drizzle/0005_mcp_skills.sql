CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args` text NOT NULL,
	`cwd` text,
	`url` text,
	`env_keys` text NOT NULL,
	`header_keys` text NOT NULL,
	`enabled` integer NOT NULL,
	`agent` integer NOT NULL,
	`chat` integer NOT NULL,
	`trust` text NOT NULL,
	`tool_policies` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_idx` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `skill_states` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`enabled` integer NOT NULL,
	`chat` integer NOT NULL
);
