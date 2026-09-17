CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "instruments_symbol_trgm_idx" ON "instruments" USING gin ("symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "instruments_name_trgm_idx" ON "instruments" USING gin ("name" gin_trgm_ops);