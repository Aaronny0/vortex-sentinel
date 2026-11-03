-- Stockage des événements : rôles applicatifs, table partitionnée en ajout seul, clés de déduplication.
-- Exécutée par le login propriétaire (migrations uniquement), qui possède le schéma et les tables.

-- Rôles de groupe, communs au cluster : sans connexion, chaque login de processus en est membre.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ingest') THEN CREATE ROLE sentinel_ingest NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN CREATE ROLE sentinel_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_purge') THEN CREATE ROLE sentinel_purge NOLOGIN; END IF;
END
$$;

CREATE SCHEMA sentinel;
REVOKE ALL ON SCHEMA sentinel FROM PUBLIC;
GRANT USAGE ON SCHEMA sentinel TO sentinel_ingest, sentinel_app, sentinel_purge;

-- Événements normalisés. received_at (horloge de Sentinel) est la clé de partition et la référence des fenêtres.
-- Les colonnes extraites servent aux règles et à la recherche ; l'événement complet reste dans body.
CREATE TABLE sentinel.event (
  id              uuid        NOT NULL,
  received_at     timestamptz NOT NULL,
  occurred_at     timestamptz NOT NULL,
  source          text        NOT NULL,
  category        text        NOT NULL,
  type            text        NOT NULL,
  outcome         text        NOT NULL,
  organization_id uuid,
  store_id        uuid,
  user_id         uuid,
  email_hash      text,
  ip              inet,
  http_status     smallint,
  body            jsonb       NOT NULL,
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Filet : un événement hors des partitions mensuelles n'est jamais perdu. Il doit rester vide (surveillé plus tard).
CREATE TABLE sentinel.event_default PARTITION OF sentinel.event DEFAULT;

CREATE INDEX event_received_at_brin ON sentinel.event USING brin (received_at);
CREATE INDEX event_type_received_at ON sentinel.event (type, received_at);
CREATE INDEX event_email_hash_received_at ON sentinel.event (email_hash, received_at) WHERE email_hash IS NOT NULL;
CREATE INDEX event_ip_received_at ON sentinel.event (ip, received_at) WHERE ip IS NOT NULL;
CREATE INDEX event_user_received_at ON sentinel.event (user_id, received_at) WHERE user_id IS NOT NULL;

-- Déduplication par identifiant d'événement, impossible sur la table partitionnée (la clé de partition entre dans toute
-- contrainte d'unicité). Conservée 30 jours : l'émetteur ne renvoie un lot que pendant quelques minutes.
CREATE TABLE sentinel.event_key (
  id          uuid        PRIMARY KEY,
  received_at timestamptz NOT NULL
);
CREATE INDEX event_key_received_at ON sentinel.event_key (received_at);

-- Ajout seul : aucun rôle applicatif ne reçoit UPDATE, DELETE ni TRUNCATE sur event.
GRANT INSERT ON sentinel.event TO sentinel_ingest;
GRANT INSERT ON sentinel.event_key TO sentinel_ingest;
GRANT SELECT (id) ON sentinel.event_key TO sentinel_ingest; -- requis par INSERT … RETURNING id
GRANT SELECT ON sentinel.event TO sentinel_app;
GRANT SELECT, DELETE ON sentinel.event_key TO sentinel_purge;

-- Partitions mensuelles à partir du mois de p_from. SECURITY DEFINER : sentinel_app les crée sans posséder la table.
CREATE FUNCTION sentinel.ensure_event_partitions(p_from date, p_months integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, sentinel
AS $$
DECLARE
  month_start date;
  partition_name text;
  created integer := 0;
BEGIN
  IF p_from IS NULL OR p_months IS NULL OR p_months < 1 OR p_months > 24 THEN
    RAISE EXCEPTION 'Nombre de mois invalide : entre 1 et 24.';
  END IF;
  FOR i IN 0 .. p_months - 1 LOOP
    month_start := (date_trunc('month', p_from) + make_interval(months => i))::date;
    partition_name := 'event_' || to_char(month_start, 'YYYY_MM');
    IF to_regclass(format('sentinel.%I', partition_name)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE sentinel.%I PARTITION OF sentinel.event FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_start::text || ' 00:00:00+00',
        (month_start + interval '1 month')::date::text || ' 00:00:00+00'
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

REVOKE ALL ON FUNCTION sentinel.ensure_event_partitions(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sentinel.ensure_event_partitions(date, integer) TO sentinel_app;
