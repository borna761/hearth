CREATE TABLE `music_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text NOT NULL,
	`folder_path` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_folders_folder_path_unique` ON `music_folders` (`folder_path`);--> statement-breakpoint
CREATE TABLE `music_speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cast_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_speakers_cast_name_unique` ON `music_speakers` (`cast_name`);--> statement-breakpoint
CREATE TABLE `music_tracks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`folder_id` integer NOT NULL,
	`source_path` text NOT NULL,
	`mtime` integer NOT NULL,
	`size` integer NOT NULL,
	`title` text NOT NULL,
	FOREIGN KEY (`folder_id`) REFERENCES `music_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `music_tracks_source_path_unique` ON `music_tracks` (`source_path`);