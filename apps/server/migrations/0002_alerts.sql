-- Alertes et points de reprise du moteur de corrélation (docs/backend.md § 5).
-- Le moteur se connecte avec sentinel_app : il lit les événements, écrit les alertes et avance ses points de reprise.
-- Aucun rôle ne peut supprimer une alerte : une alerte se clôt, elle ne disparaît pas.

CREATE TABLE sentinel.rule_checkpoint (
  rule_id      text PRIMARY KEY,
  evaluated_to timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

CREATE TABLE sentinel.alert (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       text NOT NULL,
  rule_version  integer NOT NULL CHECK (rule_version > 0),
  -- Ce qui identifie l'alerte pour sa règle : cible, compte, adresse, chemin.
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  severity      text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  -- Événements déclencheurs : les premiers sont gardés, ils datent le début du problème.
  evidence      uuid[] NOT NULL CHECK (cardinality(evidence) BETWEEN 1 AND 100),
  -- Seuils effectifs au premier constat : une alerte reste explicable après un changement de réglage.
  thresholds    jsonb NOT NULL,
  hits          integer NOT NULL DEFAULT 1 CHECK (hits > 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  closed_at     timestamptz,
  CHECK (last_seen_at >= first_seen_at),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- Une seule alerte ouverte par règle et par clé : un nouveau constat rejoint l'alerte existante.
CREATE UNIQUE INDEX alert_open_rule_key ON sentinel.alert (rule_id, key) WHERE status = 'open';
CREATE INDEX alert_last_seen ON sentinel.alert (last_seen_at DESC);

GRANT SELECT, INSERT, UPDATE ON sentinel.rule_checkpoint TO sentinel_app;
GRANT SELECT, INSERT, UPDATE ON sentinel.alert TO sentinel_app;
