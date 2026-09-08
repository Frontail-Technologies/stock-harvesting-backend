ALTER TABLE "candles" DROP CONSTRAINT "candles_pkey";--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_id_time_pk" PRIMARY KEY("id","time");--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
SELECT create_hypertable('candles', 'time', if_not_exists => TRUE, migrate_data => TRUE);
