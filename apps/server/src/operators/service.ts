import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../common/clock.ts';
import { AppError } from '../common/errors.ts';
import { seal, unseal } from './sealed.ts';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

export const roles = ['admin', 'analyst', 'observer'] as const;
export type Role = (typeof roles)[number];
export type Operator = { id: string; email: string; name: string; role: Role; totpEnabled: boolean };

export const SESSION = {
  /** Durée maximale d'une session, quelle que soit l'activité. */
  maxAgeMs: 12 * 60 * 60_000,
  /** Inactivité au-delà de laquelle il faut se reconnecter. */
  idleMs: 2 * 60 * 60_000,
  /** Fenêtre entre le mot de passe et le code. */
  challengeMs: 5 * 60_000,
  challengeAttempts: 5,
} as const;

/** Refus de connexion par adresse et par compte : au-delà, 429 pendant la fenêtre. */
export const LOGIN_LIMIT = { failures: 10, windowMs: 15 * 60_000 } as const;

const MIN_PASSWORD = 12;
export const operatorInputSchema = z.strictObject({
  email: z.email({ error: 'Adresse email invalide.' }).max(254).transform((value) => value.trim().toLowerCase()),
  name: z.string().trim().min(1, { error: 'Nom requis.' }).max(100, { error: 'Nom trop long.' }),
  role: z.enum(roles, { error: 'Rôle inconnu.' }),
  password: z.string().min(MIN_PASSWORD, { error: `Mot de passe : ${MIN_PASSWORD} caractères au moins.` }).max(256),
});

const fieldsOf = (error: z.ZodError) => Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'saisie', issue.message]));
export const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(422, 'VALIDATION_FAILED', 'Certains champs sont invalides.', fieldsOf(result.error));
  return result.data;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Adresse ou mot de passe incorrect.');
/** Empreinte de comparaison pour un compte inconnu : la réponse prend le même temps qu'un mauvais mot de passe. */
let dummyHash: Promise<string> | undefined;

type Challenge = { operatorId: string; expiresAt: number; attempts: number; pendingSecret?: string };
type OperatorRow = { id: string; email: string; name: string; role: Role; password_hash: string; totp_secret: string | null; totp_last_step: string | null; disabled: boolean };

const toOperator = (row: Pick<OperatorRow, 'id' | 'email' | 'name' | 'role' | 'totp_secret'>): Operator => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  totpEnabled: !!row.totp_secret,
});

export type RequestMeta = { ip?: string | null; userAgent?: string | null };

/**
 * Comptes des opérateurs : connexion en deux temps (mot de passe, puis code TOTP ; activation du code à la première
 * connexion), sessions par cookie dont seule l'empreinte est en base, limitation des essais, journal d'audit.
 * Les défis entre les deux étapes sont gardés en mémoire (une seule instance de Sentinel) et expirent en 5 minutes.
 */
export function createOperatorService(deps: { pool: Pool; clock: Clock; secretKey: Buffer }) {
  const { pool, clock, secretKey } = deps;
  const challenges = new Map<string, Challenge>();
  const failures = new Map<string, number[]>();

  const recentFailures = (key: string) => {
    const now = clock.now().getTime();
    const kept = (failures.get(key) ?? []).filter((at) => now - at < LOGIN_LIMIT.windowMs);
    failures.set(key, kept);
    return kept;
  };
  const limited = (keys: string[]) => keys.some((key) => recentFailures(key).length >= LOGIN_LIMIT.failures);
  const fail = (keys: string[]) => keys.forEach((key) => recentFailures(key).push(clock.now().getTime()));

  async function audit(operatorId: string | null, action: string, meta: RequestMeta = {}, target?: { type: string; id: string }, details: Record<string, unknown> = {}) {
    await pool.query(
      `INSERT INTO sentinel.operator_audit (at, operator_id, action, target_type, target_id, ip, details) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clock.now(), operatorId, action, target?.type ?? null, target?.id ?? null, meta.ip ?? null, details],
    );
  }

  async function createOperator(input: unknown, createdBy: string | null, meta: RequestMeta = {}): Promise<Operator> {
    const data = parse(operatorInputSchema, input);
    const passwordHash = await Bun.password.hash(data.password, { algorithm: 'argon2id' });
    const now = clock.now();
    const { rows } = await pool
      .query<OperatorRow>(
        `INSERT INTO sentinel.operator (email, name, role, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id, email, name, role, totp_secret`,
        [data.email, data.name, data.role, passwordHash, now],
      )
      .catch((error: { code?: string }) => {
        if (error.code === '23505') throw new AppError(409, 'EMAIL_TAKEN', 'Un opérateur utilise déjà cette adresse.', { email: 'Adresse déjà utilisée.' });
        throw error;
      });
    const operator = toOperator(rows[0]!);
    await audit(createdBy, 'operator.created', meta, { type: 'operator', id: operator.id }, { role: operator.role });
    return operator;
  }

  /** Première étape : mot de passe. Renvoie un défi pour le code, et le secret à enregistrer si le code n'est pas encore activé. */
  async function startLogin(input: unknown, meta: RequestMeta = {}) {
    const { email, password } = parse(z.strictObject({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(256) }), input);
    // Par compte, et par adresse quand elle est connue : une adresse inconnue partagée bloquerait tous les opérateurs.
    const keys = [`email:${email}`, ...(meta.ip ? [`ip:${meta.ip}`] : [])];
    if (limited(keys)) throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives. Réessayez dans quelques minutes.');
    const { rows } = await pool.query<OperatorRow>('SELECT * FROM sentinel.operator WHERE email = $1', [email]);
    const row = rows[0];
    dummyHash ??= Bun.password.hash(randomBytes(16).toString('hex'), { algorithm: 'argon2id' });
    const valid = await Bun.password.verify(password, row?.password_hash ?? (await dummyHash));
    if (!row || !valid || row.disabled) {
      fail(keys);
      await audit(row?.id ?? null, 'session.login_failed', meta, undefined, { reason: !row ? 'unknown_account' : row.disabled ? 'disabled' : 'password' });
      throw INVALID_CREDENTIALS();
    }
    const challenge = randomBytes(32).toString('base64url');
    const pendingSecret = row.totp_secret ? undefined : generateTotpSecret();
    challenges.set(challenge, { operatorId: row.id, expiresAt: clock.now().getTime() + SESSION.challengeMs, attempts: 0, pendingSecret });
    return pendingSecret
      ? { step: 'enroll' as const, challenge, enrollment: { secret: pendingSecret, uri: otpauthUri(pendingSecret, row.email) } }
      : { step: 'totp' as const, challenge };
  }

  /** Seconde étape : code TOTP (ou premier code, qui active la double authentification). Ouvre la session. */
  async function completeLogin(input: unknown, meta: RequestMeta = {}) {
    const { challenge, code } = parse(z.strictObject({ challenge: z.string().max(100), code: z.string().trim().max(10) }), input);
    const pending = challenges.get(challenge);
    const now = clock.now();
    if (!pending || pending.expiresAt < now.getTime()) {
      challenges.delete(challenge);
      throw new AppError(401, 'CHALLENGE_EXPIRED', 'Délai dépassé. Reprenez la connexion.');
    }
    const { rows } = await pool.query<OperatorRow>('SELECT * FROM sentinel.operator WHERE id = $1', [pending.operatorId]);
    const row = rows[0];
    if (!row || row.disabled) {
      challenges.delete(challenge);
      throw INVALID_CREDENTIALS();
    }
    const secret = pending.pendingSecret ?? unseal(secretKey, row.totp_secret!);
    const step = verifyTotp(secret, code, now, row.totp_last_step === null ? null : Number(row.totp_last_step));
    if (step === null) {
      pending.attempts += 1;
      if (pending.attempts >= SESSION.challengeAttempts) challenges.delete(challenge);
      fail([`email:${row.email}`, ...(meta.ip ? [`ip:${meta.ip}`] : [])]);
      await audit(row.id, 'session.code_refused', meta);
      throw new AppError(401, 'INVALID_CODE', 'Code incorrect ou déjà utilisé.');
    }
    challenges.delete(challenge);
    const token = randomBytes(32).toString('base64url');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Le pas n'avance que s'il est plus récent : deux validations simultanées du même code n'ouvrent qu'une session.
      const { rowCount } = await client.query(
        `UPDATE sentinel.operator SET totp_last_step = $2, last_login_at = $3, updated_at = $3,
           totp_secret = coalesce(totp_secret, $4)
         WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
        [row.id, step, now, pending.pendingSecret ? seal(secretKey, pending.pendingSecret) : null],
      );
      if (!rowCount) throw new AppError(401, 'INVALID_CODE', 'Code incorrect ou déjà utilisé.');
      await client.query(
        `INSERT INTO sentinel.operator_session (token_hash, operator_id, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES ($1, $2, $3, $4, $3, $5, $6)`,
        [hashToken(token), row.id, now, new Date(now.getTime() + SESSION.maxAgeMs), meta.ip ?? null, meta.userAgent?.slice(0, 512) ?? null],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await audit(row.id, pending.pendingSecret ? 'session.login_enrolled' : 'session.login', meta);
    return { token, operator: toOperator({ ...row, totp_secret: row.totp_secret ?? 'activé' }) };
  }

  /** Opérateur d'une session valide (ni révoquée, ni expirée, ni inactive trop longtemps, compte actif), ou null. */
  async function resolveSession(token: string | undefined): Promise<(Operator & { sessionId: string }) | null> {
    if (!token || token.length > 100) return null;
    const now = clock.now();
    const { rows } = await pool.query<OperatorRow & { session_id: string; last_seen_at: Date }>(
      `SELECT o.id, o.email, o.name, o.role, o.totp_secret, s.id AS session_id, s.last_seen_at
       FROM sentinel.operator_session s JOIN sentinel.operator o ON o.id = s.operator_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $3 AND NOT o.disabled`,
      [hashToken(token), now, new Date(now.getTime() - SESSION.idleMs)],
    );
    const row = rows[0];
    if (!row) return null;
    if (now.getTime() - row.last_seen_at.getTime() > 60_000)
      await pool.query('UPDATE sentinel.operator_session SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
    return { ...toOperator(row), sessionId: row.session_id };
  }

  async function logout(token: string | undefined, meta: RequestMeta = {}) {
    if (!token) return;
    const { rows } = await pool.query<{ operator_id: string }>(
      'UPDATE sentinel.operator_session SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING operator_id',
      [hashToken(token), clock.now()],
    );
    if (rows[0]) await audit(rows[0].operator_id, 'session.logout', meta);
  }

  async function listOperators() {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, totp_secret IS NOT NULL AS "totpEnabled", disabled, created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM sentinel.operator ORDER BY name`,
    );
    return rows;
  }

  /** Rôle ou désactivation. Il reste toujours au moins un administrateur actif ; désactiver ferme les sessions. */
  async function updateOperator(actor: Operator, id: string, input: unknown, meta: RequestMeta = {}) {
    const data = parse(z.strictObject({ role: z.enum(roles).optional(), disabled: z.boolean().optional() }), input);
    parse(z.uuid({ error: 'Opérateur : identifiant invalide.' }), id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT id FROM sentinel.operator WHERE role = 'admin' FOR UPDATE");
      const { rows } = await client.query<OperatorRow>('SELECT * FROM sentinel.operator WHERE id = $1 FOR UPDATE', [id]);
      const target = rows[0];
      if (!target) throw new AppError(404, 'NOT_FOUND', 'Opérateur introuvable.');
      const role = data.role ?? target.role;
      const disabled = data.disabled ?? target.disabled;
      if (target.role === 'admin' && !target.disabled && (role !== 'admin' || disabled)) {
        const { rows: admins } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sentinel.operator WHERE role = 'admin' AND NOT disabled");
        if (admins[0]!.n <= 1) throw new AppError(409, 'LAST_ADMIN', 'Il doit rester au moins un administrateur actif.');
      }
      const now = clock.now();
      await client.query('UPDATE sentinel.operator SET role = $2, disabled = $3, updated_at = $4 WHERE id = $1', [id, role, disabled, now]);
      if (disabled) await client.query('UPDATE sentinel.operator_session SET revoked_at = $2 WHERE operator_id = $1 AND revoked_at IS NULL', [id, now]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await audit(actor.id, 'operator.updated', meta, { type: 'operator', id }, data);
  }

  return { createOperator, startLogin, completeLogin, resolveSession, logout, listOperators, updateOperator, audit };
}

export type OperatorService = ReturnType<typeof createOperatorService>;
