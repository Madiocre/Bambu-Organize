CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY,
	`currency` text DEFAULT '' NOT NULL,
	`filament_cost_per_kg` real DEFAULT 0 NOT NULL,
	`machine_rate_per_hour` real DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
