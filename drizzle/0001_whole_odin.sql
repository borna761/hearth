DROP INDEX `events_allday`;--> statement-breakpoint
ALTER TABLE `events` ADD `local_end_date` text;--> statement-breakpoint
CREATE INDEX `events_allday` ON `events` (`local_date`,`local_end_date`);