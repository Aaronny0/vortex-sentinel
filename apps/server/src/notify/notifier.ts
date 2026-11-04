import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import type { Clock } from '../common/clock.ts';
import { redactForObserver } from '../dashboard/queries.ts';
import { incidentReference } from '../incidents/transitions.ts';

export type Mail = { bcc: string[]; subject: string; text: string };
export type MailSender = (mail: Mail) => Promise<void>;

/** Tentatives : 1 min, 5 min, 15 min, 1 h, puis abandon. Une notification de plus de 24 h n'est plus envoyée (périmée). */
export const NOTIFY = { retryDelaysMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000], maxAgeMs: 24 * 60 * 60_000, batch: 20 } as const;

const LABELS: Record<string, string> = { high: 'Élevée', critical: 'Critique' };

/** Transport SMTP (nodemailer) ; adresse d'expédition contrôlée, aucun en-tête construit à partir des données. */
export function smtpSender(config: { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }): MailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (mail) => {
    const result = await transport.sendMail({ from: config.from, bcc: mail.bcc, subject: mail.subject, text: mail.text });
    if (!result.accepted?.length) throw Object.assign(new Error('Email refusé par le serveur SMTP.'), { code: 'SMTP_REJECTED' });
  };
}

/**
 * Envoie les notifications en attente aux administrateurs et analystes actifs (copie cachée). Les lignes sont prises avec
 * SKIP LOCKED : deux instances n'envoient jamais la même. Le texte reste sobre et expurgé (ni adresse IP, ni empreinte de
 * compte : un email sort du système) ; le détail est dans le tableau de bord.
 */
export async function sendPendingNotifications(pool: Pool, clock: Clock, send: MailSender, dashboardOrigin: string) {
  const now = clock.now();
  const client = await pool.connect();
  let sent = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      kind: string;
      severity: string;
      attempts: number;
      created_at: Date;
      incident_id: string;
      number: string;
      title: string;
      opened_at: Date;
    }>(
      `SELECT n.id, n.kind, n.severity, n.attempts, n.created_at, i.id AS incident_id, i.number::text AS number, i.title, i.opened_at
       FROM sentinel.notification n JOIN sentinel.incident i ON i.id = n.incident_id
       WHERE n.sent_at IS NULL AND n.failed_at IS NULL AND n.next_attempt_at <= $1
       ORDER BY n.id LIMIT $2 FOR UPDATE OF n SKIP LOCKED`,
      [now, NOTIFY.batch],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { sent, failed };
    }
    const { rows: recipients } = await client.query<{ email: string }>(
      "SELECT email FROM sentinel.operator WHERE role IN ('admin', 'analyst') AND NOT disabled ORDER BY email",
    );
    for (const row of rows) {
      const expired = now.getTime() - row.created_at.getTime() > NOTIFY.maxAgeMs;
      if (expired || recipients.length === 0) {
        await client.query('UPDATE sentinel.notification SET failed_at = $2, last_error = $3 WHERE id = $1', [row.id, now, expired ? 'EXPIRED' : 'NO_RECIPIENT']);
        failed += 1;
        continue;
      }
      const reference = incidentReference(row.number);
      const label = LABELS[row.severity] ?? row.severity;
      try {
        await send({
          bcc: recipients.map((recipient) => recipient.email),
          subject: `[Sentinel] ${label} · ${reference} · ${redactForObserver(row.title)}`.slice(0, 200),
          text: [
            row.kind === 'opened' ? `Nouvel incident de gravité ${label.toLowerCase()}.` : `Incident porté à la gravité ${label.toLowerCase()}.`,
            '',
            `${reference} — ${redactForObserver(row.title)}`,
            `Ouvert le ${row.opened_at.toISOString().replace('T', ' à ').slice(0, 21)} (UTC)`,
            '',
            `Détail et prise en charge : ${dashboardOrigin}/incidents/${row.incident_id}`,
            '',
            'Message automatique de Vortex Sentinel. Les adresses IP et les comptes concernés ne figurent que dans le tableau de bord.',
          ].join('\n'),
        });
        await client.query('UPDATE sentinel.notification SET sent_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1', [row.id, now]);
        sent += 1;
      } catch (error) {
        const code = String((error as { code?: unknown }).code ?? '');
        const attempts = row.attempts + 1;
        const delay = NOTIFY.retryDelaysMs[attempts - 1];
        await client.query(
          'UPDATE sentinel.notification SET attempts = $2, last_error = $3, next_attempt_at = $4, failed_at = $5 WHERE id = $1',
          [row.id, attempts, /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'SEND_FAILED', new Date(now.getTime() + (delay ?? 0)), delay === undefined ? now : null],
        );
        failed += 1;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { sent, failed };
}
