import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Empty, ErrorState, Loading, PageHeader } from '../components/common.tsx';
import { EventTable } from '../components/event-table.tsx';
import { api, query, type SentinelEvent } from '../lib/api.ts';
import { exactDateWithZone } from '../lib/format.ts';
import { categoryLabels } from '../lib/labels.ts';

export type EventSearch = { type?: string; category?: string; outcome?: string; ip?: string; account?: string; from?: string; before?: string };

/** Valeur d'un champ datetime-local en ISO (fuseau du navigateur), ou undefined. */
const toIso = (value: FormDataEntryValue | null) => (value ? new Date(String(value)).toISOString() : undefined);
const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function EventsPage() {
  const search = useSearch({ strict: false }) as EventSearch;
  const navigate = useNavigate();
  const [limit, setLimit] = useState(100);
  const events = useQuery({
    queryKey: ['events', search, limit],
    queryFn: () => api<{ from: string; to: string; events: SentinelEvent[] }>(`/api/events${query({ ...search, limit })}`),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim() || undefined;
    navigate({
      to: '/events',
      search: { type: text('type'), category: text('category'), outcome: text('outcome'), ip: text('ip'), account: text('account'), from: toIso(form.get('from')), before: toIso(form.get('before')) },
    } as never);
  };

  return (
    <>
      <PageHeader title="Événements" meta="Donnée brute reçue par Sentinel. Chaque recherche est enregistrée dans le journal d'audit." />
      <form className="filters filters-form" onSubmit={submit} aria-label="Recherche d'événements">
        <label className="field field-inline">
          <span>Type</span>
          <input name="type" defaultValue={search.type} placeholder="auth.login" className="mono" pattern="[a-z]+(\.[a-z_]+)+" />
        </label>
        <label className="field field-inline">
          <span>Catégorie</span>
          <select name="category" defaultValue={search.category ?? ''}>
            <option value="">Toutes</option>
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-inline">
          <span>Résultat</span>
          <select name="outcome" defaultValue={search.outcome ?? ''}>
            <option value="">Tous</option>
            <option value="failure">Échec</option>
            <option value="success">Réussite</option>
          </select>
        </label>
        <label className="field field-inline">
          <span>Adresse IP</span>
          <input name="ip" defaultValue={search.ip} className="mono" placeholder="203.0.113.7" />
        </label>
        <label className="field field-inline">
          <span>Compte (empreinte)</span>
          <input name="account" defaultValue={search.account} className="mono" placeholder="8 caractères ou plus" pattern="[0-9a-f]{8,64}" />
        </label>
        <label className="field field-inline">
          <span>Depuis</span>
          <input name="from" type="datetime-local" defaultValue={toLocalInput(search.from)} />
        </label>
        <label className="field field-inline">
          <span>Jusqu'à</span>
          <input name="before" type="datetime-local" defaultValue={toLocalInput(search.before)} />
        </label>
        <button type="submit" className="button button-primary">
          Rechercher
        </button>
      </form>
      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <ErrorState error={events.error} retry={() => events.refetch()} />
      ) : (
        <>
          <p className="muted note">
            Du {exactDateWithZone(events.data.from)} au {exactDateWithZone(events.data.to)} · {events.data.events.length} événement{events.data.events.length > 1 ? 's' : ''}
            {events.data.events.length === limit ? ' (limite atteinte)' : ''}
          </p>
          {events.data.events.length === 0 ? (
            <Empty>Aucun événement pour cette recherche. Par défaut, la période est des dernières 24 heures.</Empty>
          ) : (
            <EventTable events={events.data.events} caption="Résultats de la recherche" />
          )}
          {events.data.events.length === limit && limit < 100 && (
            <button type="button" className="button button-secondary" onClick={() => setLimit(100)}>
              Afficher plus
            </button>
          )}
        </>
      )}
    </>
  );
}
