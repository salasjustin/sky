import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_VERSION = 1;

/** A value as stored: the GCM tag rides at the end of `ciphertext`. */
export type Sealed = { ciphertext: Buffer; nonce: Buffer; keyVersion: number };

/** The AAD binding a sealed value to its row, so a ciphertext copied to another row won't open. */
export const envSecretAad = (envId: string, name: string) =>
  `env:${envId}:${name}`;
export const webhookSecretAad = (webhookId: string) => `webhook:${webhookId}`;
export const runEnvVarAad = (runId: string, name: string) =>
  `run:${runId}:${name}`;

/** AES-256-GCM under `key` with a fresh nonce. */
export function seal(key: Buffer, plaintext: string, aad: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { ciphertext, nonce, keyVersion: KEY_VERSION };
}

/** Throws when the key, the AAD or the bytes don't match what was sealed. */
export function open(key: Buffer, sealed: Sealed, aad: string): string {
  if (sealed.keyVersion !== KEY_VERSION) {
    throw new Error(`no key for version ${sealed.keyVersion}`);
  }
  const body = sealed.ciphertext.subarray(0, -TAG_BYTES);
  const tag = sealed.ciphertext.subarray(-TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString(
    "utf8",
  );
}
