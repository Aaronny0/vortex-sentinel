import { r01ProbeDown } from './r01-probe-down.ts';
import { r02HeartbeatLost } from './r02-heartbeat-lost.ts';
import { r03SlowRoute } from './r03-slow-route.ts';
import { r04ServerErrors } from './r04-server-errors.ts';
import { r05AccountBruteForce } from './r05-account-brute-force.ts';
import { r06CredentialStuffing } from './r06-credential-stuffing.ts';
import { r07Compromise } from './r07-compromise.ts';
import { r08AccessDenied } from './r08-access-denied.ts';
import { r09NewIpPrivilegeChange } from './r09-new-ip-privilege-change.ts';
import { r10RefundSpike } from './r10-refund-spike.ts';
import { r11CashGap } from './r11-cash-gap.ts';
import { r12StockAdjustments } from './r12-stock-adjustments.ts';
import { r13OffHours } from './r13-off-hours.ts';
import { r14ApiProbing } from './r14-api-probing.ts';
import { r16MailFailures } from './r16-mail-failures.ts';
import { r15CertificateExpiry } from './r15-certificate-expiry.ts';
import { r17DiskSpace } from './r17-disk-space.ts';
import type { Rule } from './types.ts';

/** Règles actives (docs/conception.md § 6), dans l'ordre d'évaluation. */
export const rules: readonly Rule[] = [
  r01ProbeDown,
  r02HeartbeatLost,
  r03SlowRoute,
  r04ServerErrors,
  r05AccountBruteForce,
  r06CredentialStuffing,
  r07Compromise,
  r08AccessDenied,
  r09NewIpPrivilegeChange,
  r10RefundSpike,
  r11CashGap,
  r12StockAdjustments,
  r13OffHours,
  r14ApiProbing,
  r15CertificateExpiry,
  r16MailFailures,
  r17DiskSpace,
];
