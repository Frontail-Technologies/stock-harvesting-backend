ALTER TABLE "ai_settings" ADD COLUMN "encrypted_api_key" jsonb;
ALTER TABLE "ai_settings" ADD COLUMN "api_key_updated_at" timestamp with time zone;
