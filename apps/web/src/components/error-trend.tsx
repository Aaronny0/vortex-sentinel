import { Link } from '@tanstack/react-router';
import type { ErrorBucket } from '../lib/api.ts';
import { exactDate, number, zoneLabel } from '../lib/format.ts';

const server = (value: number) => `${number(value)} ${value > 1 ? 'erreurs serveur' : 'erreur serveur'}`;
const ui = (value: number) => `${number(value)} ${value > 1 ? "erreurs d'interface" : "erreur d'interface"}`;

/**
 * Évolution des erreurs sur 24 h, par heure : erreurs serveur (`app.error`, pétrole) et d'interface (`ui.error`, gris).
 * Barres empilées (serveur en bas) avec échelle et axe légendé ; valeurs exactes au survol et dans un tableau pour les
 * lecteurs d'écran.
 * Les totaux et, pour les analystes, chaque heure mènent à la liste des événements correspondants.
 */
export function ErrorTrend({ buckets, linked }: { buckets: ErrorBucket[]; linked: boolean }) {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (!first || !last) return null;
  const total = (bucket: ErrorBucket) => bucket.server + bucket.interface;
  const max = Math.max(...buckets.map(total));
  const totals = buckets.reduce((sum, bucket) => ({ server: sum.server + bucket.server, ui: sum.ui + bucket.interface }), { server: 0, ui: 0 });
  const label = (bucket: ErrorBucket) => `${exactDate(bucket.start)} – ${exactDate(bucket.end).slice(11, 16)} : ${server(bucket.server)}, ${ui(bucket.interface)}`;
  const height = (value: number) => `${max ? (value / max) * 100 : 0}%`;
  const period = { from: first.start, before: last.end };

  const totalLink = (text: string, type: string, className: string) => (
    <span className="trend-total">
      <span className={`trend-swatch ${className}`} aria-hidden="true" />
      {linked ? (
        <Link to="/events" search={{ type, ...period }} className="link numeric">
          {text}
        </Link>
      ) : (
        <span className="numeric">{text}</span>
      )}
    </span>
  );

  return (
    <>
      <p className="trend-totals">
        {totalLink(server(totals.server), 'app.error', 'trend-server')}
        {totalLink(ui(totals.ui), 'ui.error', 'trend-interface')}
      </p>
      {max === 0 ? (
        <p className="muted">Aucune erreur serveur ni d'interface en 24 h.</p>
      ) : (
        <div className="trend" aria-hidden="true">
          <div className="trend-scale">
            <span>{number(max)}</span>
            <span>0</span>
          </div>
          <div className="trend-bars">
            {buckets.map((bucket) => {
              const bars = (
                <>
                  <span className="trend-bar trend-server" style={{ height: height(bucket.server) }} />
                  <span className="trend-bar trend-interface" style={{ height: height(bucket.interface) }} />
                </>
              );
              return linked && total(bucket) > 0 ? (
                <Link
                  key={bucket.start}
                  to="/events"
                  search={{ type: bucket.server ? 'app.error' : 'ui.error', from: bucket.start, before: bucket.end }}
                  className="trend-column"
                  title={label(bucket)}
                  tabIndex={-1}
                >
                  {bars}
                </Link>
              ) : (
                <span key={bucket.start} className="trend-column" title={label(bucket)}>
                  {bars}
                </span>
              );
            })}
          </div>
        </div>
      )}
      <p className="buckets-axis muted">
        <span>{exactDate(first.start)}</span>
        <span>Heures en {zoneLabel(new Date(last.end))}</span>
        <span>{exactDate(last.end)}</span>
      </p>
      <div className="sr-only">
        <table>
          <caption>Erreurs par heure sur les 24 dernières heures</caption>
          <thead>
            <tr>
              <th scope="col">Heure</th>
              <th scope="col">Erreurs serveur</th>
              <th scope="col">Erreurs d'interface</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.start}>
                <th scope="row">{exactDate(bucket.start)}</th>
                <td>{bucket.server}</td>
                <td>{bucket.interface}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
