-- Incidents : regroupement des alertes de gravité moyenne ou plus, cycle de vie, historique (docs/conception.md § 7).
-- Le moteur (sentinel_app) ouvre et alimente les incidents dans la transaction de ses alertes ; les transitions des
-- opérateurs passent par le même rôle. L'historique est en ajout seul : aucun rôle ne peut le modifier ni le supprimer.

-- Les alertes des règles de disponibilité peuvent résoudre seules leur incident quand le service est rétabli.
ALTER TABLE sentinel.alert ADD COLUMN auto_resolve boolean NOT NULL DEFAULT false;

CREATE TABLE sentinel.incident (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Numéro lisible (INC-000042), attribué dans l'ordre d'ouverture.
  number      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- Clé des alertes regroupées : compte, adresse, cible. R05 puis R07 sur un même compte rejoignent le même incident.
  key         text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  severity    text NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
  status      text NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'false_positive')),
  -- Opérateur qui a pris l'incident en charge ; les comptes d'opérateurs viendront avec le tableau de bord.
  assignee_id uuid,
  opened_at   timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  resolved_at timestamptz,
  closed_at   timestamptz,
  CHECK (updated_at >= opened_at),
  CHECK (status <> 'acknowledged' OR assignee_id IS NOT NULL)
);

-- Un seul incident actif par clé : une nouvelle alerte rejoint celui-ci. Résolu, clos ou faux positif, il n'est plus actif.
CREATE UNIQUE INDEX incident_active_key ON sentinel.incident (key) WHERE status IN ('open', 'acknowledged', 'in_progress');
CREATE INDEX incident_status_opened ON sentinel.incident (status, opened_at DESC);

CREATE TABLE sentinel.incident_alert (
  incident_id uuid NOT NULL REFERENCES sentinel.incident (id),
  -- Une alerte appartient à un seul incident.
  alert_id    uuid PRIMARY KEY REFERENCES sentinel.alert (id),
  linked_at   timestamptz NOT NULL
);
CREATE INDEX incident_alert_incident ON sentinel.incident_alert (incident_id);

CREATE TABLE sentinel.incident_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES sentinel.incident (id),
  at          timestamptz NOT NULL,
  -- NULL : le système (ouverture, nouvelle alerte, résolution automatique).
  actor_id    uuid,
  kind        text NOT NULL CHECK (kind IN ('opened', 'alert_linked', 'severity_raised', 'transition', 'comment')),
  from_status text,
  to_status   text,
  comment     text CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 2000)
);
CREATE INDEX incident_history_incident ON sentinel.incident_history (incident_id, at);

GRANT SELECT, INSERT, UPDATE ON sentinel.incident TO sentinel_app;
GRANT SELECT, INSERT ON sentinel.incident_alert TO sentinel_app;
GRANT SELECT, INSERT ON sentinel.incident_history TO sentinel_app;
