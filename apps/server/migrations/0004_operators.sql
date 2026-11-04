-- Opérateurs de Sentinel, sessions et journal d'audit (docs/conception.md § 8.1 et § 9).
-- Comptes propres à Sentinel, distincts de ceux de Vortex ; aucune création en libre-service (script d'administration ou
-- administrateur depuis le tableau de bord). Double authentification obligatoire (TOTP).

CREATE TABLE sentinel.operator (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  role           text NOT NULL CHECK (role IN ('admin', 'analyst', 'observer')),
  -- Argon2id (Bun.password).
  password_hash  text NOT NULL,
  -- Secret TOTP chiffré (AES-256-GCM, clé OPERATOR_SECRET_KEY) ; NULL tant que la double authentification n'est pas activée.
  totp_secret    text,
  -- Dernier pas de temps accepté : un code déjà utilisé est refusé.
  totp_last_step bigint,
  disabled       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  last_login_at  timestamptz
);

CREATE TABLE sentinel.operator_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Empreinte SHA-256 du jeton du cookie : une lecture de la table ne donne aucune session utilisable.
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  operator_id  uuid NOT NULL REFERENCES sentinel.operator (id),
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);
CREATE INDEX operator_session_operator ON sentinel.operator_session (operator_id);

-- Qui a fait quoi : connexions, consultations d'événements (adresses IP), transitions, gestion des comptes.
CREATE TABLE sentinel.operator_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL,
  operator_id uuid REFERENCES sentinel.operator (id),
  action      text NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  target_type text,
  target_id   text,
  ip          inet,
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX operator_audit_at ON sentinel.operator_audit (at DESC);
CREATE INDEX operator_audit_operator ON sentinel.operator_audit (operator_id, at DESC);

ALTER TABLE sentinel.incident ADD CONSTRAINT incident_assignee_fk FOREIGN KEY (assignee_id) REFERENCES sentinel.operator (id);
ALTER TABLE sentinel.incident_history ADD CONSTRAINT incident_history_actor_fk FOREIGN KEY (actor_id) REFERENCES sentinel.operator (id);

GRANT SELECT, INSERT, UPDATE ON sentinel.operator TO sentinel_app;
GRANT SELECT, INSERT, UPDATE ON sentinel.operator_session TO sentinel_app;
GRANT SELECT, INSERT ON sentinel.operator_audit TO sentinel_app;
