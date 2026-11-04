import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Chiffrement des secrets TOTP en base (AES-256-GCM, clé OPERATOR_SECRET_KEY) : une copie de la base ne suffit pas à
 * produire des codes. Format : `v1.<iv>.<tag>.<chiffré>` en base64url.
 */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Secret chiffré illisible.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
