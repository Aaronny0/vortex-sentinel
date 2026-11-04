-- Rétention (docs/conception.md § 5 et § 8) : événements conservés 2 ans, puis supprimés par partitions entières ;
-- clés de déduplication gardées 30 jours. La fonction fixe elle-même les durées : l'application peut la déclencher, pas
-- choisir de supprimer des données plus récentes.

CREATE FUNCTION sentinel.purge_expired(p_now timestamptz)
RETURNS TABLE (dropped_partitions integer, deleted_keys bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, sentinel AS $$
DECLARE
  -- Une partition est supprimée quand tout son mois a plus de 2 ans.
  v_limit date := (date_trunc('month', p_now AT TIME ZONE 'UTC') - interval '24 months')::date;
  v_partition record;
  v_dropped integer := 0;
  v_keys bigint;
BEGIN
  -- Une horloge déréglée vers le futur ne doit pas tout effacer : l'instant fourni ne peut dépasser l'heure de la base.
  IF p_now > now() + interval '1 day' THEN
    RAISE EXCEPTION 'Date de purge dans le futur refusée.';
  END IF;
  FOR v_partition IN
    SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'sentinel.event'::regclass AND c.relname ~ '^event_\d{4}_\d{2}$'
      AND to_date(substr(c.relname, 7), 'YYYY_MM') < v_limit
  LOOP
    EXECUTE format('ALTER TABLE sentinel.event DETACH PARTITION sentinel.%I', v_partition.relname);
    EXECUTE format('DROP TABLE sentinel.%I', v_partition.relname);
    v_dropped := v_dropped + 1;
  END LOOP;
  DELETE FROM sentinel.event_key WHERE received_at < p_now - interval '30 days';
  GET DIAGNOSTICS v_keys = ROW_COUNT;
  RETURN QUERY SELECT v_dropped, v_keys;
END;
$$;

REVOKE ALL ON FUNCTION sentinel.purge_expired(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sentinel.purge_expired(timestamptz) TO sentinel_app, sentinel_purge;
