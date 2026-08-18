CREATE TABLE `file_plates` (
	`id` text PRIMARY KEY,
	`file_id` text NOT NULL,
	`plate_index` integer NOT NULL,
	`name` text,
	`prediction_sec` integer,
	`weight_g` real,
	`printer_model_code` text,
	`nozzle_diameters` text,
	`support_used` integer DEFAULT false NOT NULL,
	`label_object_enabled` integer DEFAULT false NOT NULL,
	`object_count` integer DEFAULT 0 NOT NULL,
	`gcode_path` text,
	`thumbnail_r2_key` text,
	CONSTRAINT `fk_file_plates_file_id_print_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `print_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text,
	`payload` text,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_job_events_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`notes` text,
	`printer_id` text,
	`file_id` text,
	`plate_id` text,
	`status` text DEFAULT 'backlog' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`copies` integer DEFAULT 1 NOT NULL,
	`estimated_min` integer NOT NULL,
	`estimate_source` text DEFAULT 'manual' NOT NULL,
	`buffer_min` integer DEFAULT 15 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`deadline` text,
	`requested_by` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_jobs_printer_id_printers_id_fk` FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_jobs_file_id_print_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `print_files`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_jobs_plate_id_file_plates_id_fk` FOREIGN KEY (`plate_id`) REFERENCES `file_plates`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `plate_filaments` (
	`id` text PRIMARY KEY,
	`plate_id` text NOT NULL,
	`filament_index` integer NOT NULL,
	`tray_info_idx` text,
	`type` text,
	`color_hex` text,
	`used_m` real,
	`used_g` real,
	CONSTRAINT `fk_plate_filaments_plate_id_file_plates_id_fk` FOREIGN KEY (`plate_id`) REFERENCES `file_plates`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `print_files` (
	`id` text PRIMARY KEY,
	`filename` text NOT NULL,
	`r2_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`kind` text DEFAULT 'project' NOT NULL,
	`slicer_name` text,
	`slicer_version` text,
	`plate_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `printer_status` (
	`printer_id` text PRIMARY KEY,
	`gcode_state` text,
	`current_job_id` text,
	`subtask_name` text,
	`layer_num` integer,
	`total_layer_num` integer,
	`percent_done` integer,
	`remaining_min` integer,
	`nozzle_temp_c` real,
	`bed_temp_c` real,
	`ams_json` text,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_printer_status_printer_id_printers_id_fk` FOREIGN KEY (`printer_id`) REFERENCES `printers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_printer_status_current_job_id_jobs_id_fk` FOREIGN KEY (`current_job_id`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `printers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`model_code` text NOT NULL,
	`serial_number` text,
	`nozzle_diameter_mm` real DEFAULT 0.4 NOT NULL,
	`extruder_count` integer DEFAULT 1 NOT NULL,
	`has_ams` integer DEFAULT false NOT NULL,
	`ip_address` text,
	`access_code` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_plates_file_index_idx` ON `file_plates` (`file_id`,`plate_index`);--> statement-breakpoint
CREATE INDEX `job_events_job_idx` ON `job_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_position_idx` ON `jobs` (`status`,`position`);--> statement-breakpoint
CREATE INDEX `jobs_printer_idx` ON `jobs` (`printer_id`);--> statement-breakpoint
CREATE INDEX `plate_filaments_plate_idx` ON `plate_filaments` (`plate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `printers_serial_idx` ON `printers` (`serial_number`);