-- Notifications email des incidents élevés et critiques (docs/conception.md § 7.1). File d'attente écrite dans la
-- transaction de l'incident, envoyée ensuite : une panne du serveur de mail ne bloque jamais la détection.

CREATE TABLE sentinel.notification (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id     uuid NOT NULL REFERENCES sentinel.incident (id),
  -- Ouverture d'un incident élevé ou critique, ou incident porté à l'une de ces gravités.
  kind            text NOT NULL CHECK (kind IN ('opened', 'raised')),
  severity        text NOT NULL CHECK (severity IN ('high', 'critical')),
  created_at      timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  sent_at         timestamptz,
  failed_at       timestamptz,
  last_error      text CHECK (last_error IS NULL OR last_error ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- Une seule notification par incident et par gravité atteinte.
  UNIQUE (incident_id, severity)
);
CREATE INDEX notification_pending ON sentinel.notification (next_attempt_at) WHERE sent_at IS NULL AND failed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON sentinel.notification TO sentinel_app;
