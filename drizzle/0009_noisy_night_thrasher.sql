DROP INDEX `photos_rotation`;--> statement-breakpoint
ALTER TABLE `photos` ADD `kind` text DEFAULT 'family' NOT NULL;--> statement-breakpoint
CREATE INDEX `photos_rotation` ON `photos` (`kind`,`orientation`,`last_shown`);