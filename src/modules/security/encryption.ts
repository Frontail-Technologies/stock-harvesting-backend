import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

import { env } from "../../shared/env";
import { ENCRYPTION_ALGORITHM, ENCRYPTION_IV_BYTES } from "../../shared/constants";

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

function getKey() {
  return createHash("sha256").update(env.ENCRYPTION_MASTER_KEY).digest();
}

export function encryptField(value: string): EncryptedValue {
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    keyVersion: env.ENCRYPTION_KEY_VERSION,
  };
}

export function decryptField(value: EncryptedValue): string {
  const decipher = createDecipheriv(
    ENCRYPTION_ALGORITHM,
    getKey(),
    Buffer.from(value.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(value.authTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
