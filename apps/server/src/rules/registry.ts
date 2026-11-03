import { r01ProbeDown } from './r01-probe-down.ts';
import { r02HeartbeatLost } from './r02-heartbeat-lost.ts';
import { r15CertificateExpiry } from './r15-certificate-expiry.ts';
import { r17DiskSpace } from './r17-disk-space.ts';
import type { Rule } from './types.ts';

/** Règles actives, dans l'ordre d'évaluation. Les autres règles de la conception (§ 6) s'ajouteront ici. */
export const rules: readonly Rule[] = [r01ProbeDown, r02HeartbeatLost, r15CertificateExpiry, r17DiskSpace];
