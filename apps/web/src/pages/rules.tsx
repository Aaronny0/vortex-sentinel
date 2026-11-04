import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Empty, ErrorState, Loading, PageHeader, Timestamp } from '../components/common.tsx';
import { SeverityBadge } from '../components/severity.tsx';
import { api, type RuleSummary } from '../lib/api.ts';
import { kindLabels, ruleNames, thresholdLabels } from '../lib/labels.ts';
import { can, useOperator } from '../session.tsx';

export function RulesPage() {
  const operator = useOperator();
  const analyst = can(operator.role, ['admin', 'analyst']);
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<RuleSummary[]>('/api/rules'), refetchInterval: 30_000 });
  return (
    <>
      <PageHeader title="Règles" meta="Ce qui est surveillé et comment. Les seuils sont dans le code de Sentinel ; chaque alerte garde ceux qui l'ont déclenchée." />
      {rules.isPending ? (
        <Loading />
      ) : rules.isError ? (
        <ErrorState error={rules.error} retry={() => rules.refetch()} />
      ) : rules.data.length === 0 ? (
        <Empty>Aucune règle active.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Règles de corrélation</caption>
            <thead>
              <tr>
                <th scope="col">Règle</th>
                <th scope="col">Gravité</th>
                <th scope="col">Type</th>
                <th scope="col">Seuils</th>
                <th scope="col" className="numeric">
                  Alertes
                </th>
                <th scope="col" className="numeric">
                  Faux positifs
                </th>
                <th scope="col">Dernier constat</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.map((rule) => (
                <tr key={rule.id} id={rule.id}>
                  <td className="cell-title">
                    <span>
                      <span className="mono">{rule.id}</span> {ruleNames[rule.id] ?? ''}
                    </span>
                    <span className="muted">version {rule.version}</span>
                  </td>
                  <td>
                    <SeverityBadge severity={rule.severity} />
                  </td>
                  <td>{kindLabels[rule.kind] ?? rule.kind}</td>
                  <td>
                    <ul className="thresholds">
                      {Object.entries(rule.thresholds).map(([key, value]) => (
                        <li key={key}>
                          <span className="muted">{thresholdLabels[key] ?? key}</span> <span className="mono">{value}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="numeric">
                    {analyst && rule.alerts > 0 ? (
                      <Link to="/alerts" search={{ status: 'all', rule: rule.id }} className="link">
                        {rule.alerts}
                      </Link>
                    ) : (
                      rule.alerts
                    )}
                    {rule.openAlerts > 0 && <span className="muted"> ({rule.openAlerts} ouverte{rule.openAlerts > 1 ? 's' : ''})</span>}
                  </td>
                  <td className="numeric">{rule.falsePositives}</td>
                  <td className="nowrap">
                    <Timestamp value={rule.lastSeenAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
