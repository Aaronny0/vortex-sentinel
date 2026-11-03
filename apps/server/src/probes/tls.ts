import { isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';
import type { EventInput } from '@sentinel/schema';
import type { Clock } from '../common/clock.ts';
import { probeEvent, safeCode } from './event.ts';

export type TlsTarget = { host: string; port: number };

export const TLS_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lit le certificat présenté par le serveur et calcule les jours restants avant expiration, à l'heure de l'horloge
 * injectée. La connexion accepte un certificat invalide pour pouvoir le décrire (expiré, autosigné, nom différent) :
 * c'est précisément ce que la sonde doit signaler. Succès : certificat reconnu et pas encore expiré.
 */
export function checkCertificate(
  target: TlsTarget,
  deps: { clock: Clock; timeoutMs?: number; ca?: string | Buffer },
): Promise<EventInput> {
  const name = `${target.host}:${target.port}`;
  const failure = (code: string, extra: Record<string, string | number | boolean> = {}) =>
    probeEvent('tls.certificate', 'failure', deps.clock, { attributes: { target: name, code, ...extra } });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (event: EventInput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(event);
    };
    const socket = connect({
      host: target.host,
      port: target.port,
      servername: isIP(target.host) ? undefined : target.host,
      rejectUnauthorized: false,
      ...(deps.ca && { ca: deps.ca }),
    });
    const timer = setTimeout(() => settle(failure('TIMEOUT')), deps.timeoutMs ?? TLS_TIMEOUT_MS);

    socket.once('secureConnect', () => {
      const certificate: Partial<PeerCertificate> = socket.getPeerCertificate();
      const validTo = certificate.valid_to ? new Date(certificate.valid_to) : undefined;
      if (!validTo || Number.isNaN(validTo.getTime())) return settle(failure('CERTIFICATE_UNREADABLE'));
      const daysLeft = Math.floor((validTo.getTime() - deps.clock.now().getTime()) / DAY_MS);
      const authorizationError = socket.authorizationError ? safeCode(String(socket.authorizationError), 'UNTRUSTED') : undefined;
      const valid = socket.authorized && daysLeft >= 0;
      settle(
        probeEvent('tls.certificate', valid ? 'success' : 'failure', deps.clock, {
          attributes: {
            target: name,
            validTo: validTo.toISOString(),
            daysLeft,
            authorized: socket.authorized,
            ...(authorizationError && { code: authorizationError }),
            ...(!authorizationError && daysLeft < 0 && { code: 'CERT_HAS_EXPIRED' }),
          },
        }),
      );
    });
    socket.once('error', (error: NodeJS.ErrnoException) => settle(failure(safeCode(error.code, 'UNREACHABLE'))));
  });
}
