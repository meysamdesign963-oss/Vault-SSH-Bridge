/**
 * Vault SSH Bridge — SSH host key generation & fingerprints.
 * Keys are generated once on first run and persisted in the plugin data.json.
 */

import * as crypto from 'crypto';
import * as ssh2 from 'ssh2';

export interface HostKeySet {
  ed25519: string;
  rsa: string;
}

/** Generate a fresh ed25519 + RSA-2048 host key pair (PEM private keys). */
export function generateHostKeys(): HostKeySet {
  const utils = (ssh2 as unknown as { utils: any }).utils;
  const ed = utils.generateKeyPairSync('ed25519');
  const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 });
  return {
    ed25519: String(ed.private),
    rsa: String(rsa.private),
  };
}

/**
 * OpenSSH-style SHA256 fingerprint of the host key public part,
 * so users can verify it with `ssh-keygen -lf` on the client side.
 */
export function hostKeyFingerprint(privPem: string): string {
  if (!privPem) return '—';
  try {
    const utils = (ssh2 as unknown as { utils: any }).utils;
    const parsed = utils.parseKey(privPem);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (key && typeof key.getPublicSSH === 'function') {
      const blob: Buffer = key.getPublicSSH();
      return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
    }
  } catch {
    /* fall through to SPKI fallback */
  }
  try {
    const pub = crypto.createPublicKey(privPem);
    const der = pub.export({ format: 'der', type: 'spki' }) as Buffer;
    return 'SHA256:' + crypto.createHash('sha256').update(der).digest('base64').replace(/=+$/, '');
  } catch {
    return 'unavailable';
  }
}
