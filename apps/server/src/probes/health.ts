import type { EventInput } from '@sentinel/schema';
import type { Clock } from '../common/clock.ts';
import { probeEvent, safeCode } from './event.ts';

export type HealthTarget = { name: string; url: string };

export const HEALTH_TIMEOUT_MS = 5_000;
/** Une page d'erreur n'est lue que pour son code (`{ code, error }` de Vortex) : au-delà, elle est ignorée. */
const MAX_ERROR_BODY_BYTES = 4_096;

async function readErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_ERROR_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof body === 'object' && body !== null && 'code' in body ? safeCode(body.code, '') || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Interroge un point de santé comme le ferait un utilisateur : seule une réponse 2xx compte comme un succès. Une
 * redirection est un échec (une sonde doit viser l'adresse finale), de même qu'un délai dépassé ou un service injoignable.
 */
export async function checkHealth(target: HealthTarget, deps: { clock: Clock; timeoutMs?: number }): Promise<EventInput> {
  const url = new URL(target.url);
  const started = deps.clock.monotonic();
  const elapsed = () => Math.round(deps.clock.monotonic() - started);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? HEALTH_TIMEOUT_MS),
      headers: { accept: 'application/json', 'user-agent': 'vortex-sentinel-probe' },
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return probeEvent('probe.check', 'failure', deps.clock, {
      attributes: { target: target.name, route: url.pathname, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE', durationMs: elapsed() },
    });
  }
  const ok = response.status >= 200 && response.status < 300;
  const code = ok ? undefined : ((await readErrorCode(response).catch(() => undefined)) ?? `HTTP_${response.status}`);
  if (ok) await response.body?.cancel().catch(() => undefined);
  return probeEvent('probe.check', ok ? 'success' : 'failure', deps.clock, {
    http: { method: 'GET', route: url.pathname, status: response.status, durationMs: elapsed() },
    attributes: { target: target.name, ...(code && { code }) },
  });
}
