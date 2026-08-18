CREATE TABLE `plate_thumbnails` (
	`plate_id` text PRIMARY KEY,
	`content_type` text DEFAULT 'image/png' NOT NULL,
	`data_base64` text NOT NULL,
	`size_bytes` integer NOT NULL,
	CONSTRAINT `fk_plate_thumbnails_plate_id_file_plates_id_fk` FOREIGN KEY (`plate_id`) REFERENCES `file_plates`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `file_plates` ADD `has_thumbnail` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `file_plates` DROP COLUMN `thumbnail_r2_key`;--> statement-breakpoint
ALTER TABLE `print_files` DROP COLUMN `r2_key`;