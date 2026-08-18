CREATE TABLE `filament_prices` (
	`type` text PRIMARY KEY,
	`cost_per_kg` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_settings` DROP COLUMN `filament_cost_per_kg`;