import { Fragment, useState } from 'react';
import type { SentinelEvent } from '../lib/api.ts';
import { exactDate, exactDateWithZone } from '../lib/format.ts';
import { categoryLabels } from '../lib/labels.ts';

/** Tableau dense d'événements ; chaque ligne s'ouvre sur l'événement complet, en JSON lisible. */
export function EventTable({ events, caption }: { events: SentinelEvent[]; caption: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="table-wrap">
      <table className="table table-dense">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Reçu</th>
            <th scope="col">Type</th>
            <th scope="col">Résultat</th>
            <th scope="col">Catégorie</th>
            <th scope="col">Adresse IP</th>
            <th scope="col">Compte</th>
            <th scope="col">HTTP</th>
            <th scope="col">
              <span className="sr-only">Détail</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <Fragment key={event.id}>
              <tr className={open === event.id ? 'row-selected' : undefined}>
                <td className="mono nowrap" title={exactDateWithZone(event.receivedAt)}>
                  {exactDate(event.receivedAt)}
                </td>
                <td className="mono">{event.type}</td>
                <td>
                  <span className={`outcome outcome-${event.outcome}`}>{event.outcome === 'failure' ? 'Échec' : event.outcome === 'success' ? 'Réussite' : 'Inconnu'}</span>
                </td>
                <td>{categoryLabels[event.category] ?? event.category}</td>
                <td className="mono">{event.ip ?? '—'}</td>
                <td className="mono" title={event.emailHash ?? undefined}>
                  {event.emailHash ? event.emailHash.slice(0, 8) : '—'}
                </td>
                <td className="mono numeric">{event.httpStatus ?? '—'}</td>
                <td>
                  <button type="button" className="button button-ghost button-small" aria-expanded={open === event.id} onClick={() => setOpen(open === event.id ? null : event.id)}>
                    {open === event.id ? 'Masquer' : 'Voir'}
                  </button>
                </td>
              </tr>
              {open === event.id && (
                <tr className="row-detail">
                  <td colSpan={8}>
                    <pre className="json">{JSON.stringify(event.body, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
