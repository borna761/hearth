CREATE TABLE `connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`secrets` blob NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_success` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`title` text NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`local_date` text,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`status` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_window` ON `events` (`starts_at`,`ends_at`);--> statement-breakpoint
CREATE INDEX `events_allday` ON `events` (`local_date`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`title` text NOT NULL,
	`quantity` text,
	`category` text,
	`checked` integer DEFAULT false NOT NULL,
	`due_at` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pending_writes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_path` text NOT NULL,
	`mtime` integer NOT NULL,
	`size` integer NOT NULL,
	`cached_path` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`orientation` text NOT NULL,
	`blur_hash` text,
	`taken_at` integer,
	`shown_count` integer DEFAULT 0 NOT NULL,
	`last_shown` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_source_path_unique` ON `photos` (`source_path`);--> statement-breakpoint
CREATE INDEX `photos_rotation` ON `photos` (`orientation`,`last_shown`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`color` text,
	`group_label` text,
	`sync_token` text,
	`enabled` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_connection_id_external_id_unique` ON `sources` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`avatar_path` text,
	`pin_hash` text NOT NULL,
	`view_mode` text DEFAULT 'standard' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visibility` (
	`user_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`visible` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`user_id`, `source_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
