process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/stock_harvesting_test";
process.env.ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET ?? "test-access-token-secret-with-32-chars";
process.env.REFRESH_TOKEN_SECRET =
  process.env.REFRESH_TOKEN_SECRET ?? "test-refresh-token-secret-with-32-chars";
process.env.ENCRYPTION_MASTER_KEY =
  process.env.ENCRYPTION_MASTER_KEY ?? "test-encryption-master-key-32-chars";
