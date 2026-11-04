import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Card, Empty, ErrorState, Loading, PageHeader, Timestamp } from '../components/common.tsx';
import { api, ApiError, type Role } from '../lib/api.ts';
import { roleLabels } from '../lib/labels.ts';
import { useOperator } from '../session.tsx';

type OperatorRow = { id: string; email: string; name: string; role: Role; totpEnabled: boolean; disabled: boolean; createdAt: string; lastLoginAt: string | null };
type AuditRow = { id: number; at: string; action: string; targetType: string | null; targetId: string | null; ip: string | null; details: Record<string, unknown>; operator: string | null };

const actionLabels: Record<string, string> = {
  'session.login': 'Connexion',
  'session.login_enrolled': 'Connexion, double authentification activée',
  'session.login_failed': 'Connexion refusée',
  'session.code_refused': 'Code refusé',
  'session.logout': 'Déconnexion',
  'operator.created': 'Opérateur créé',
  'operator.updated': 'Opérateur modifié',
  'incident.transition': "Changement de statut d'incident",
  'incident.commented': 'Commentaire sur un incident',
  'event.viewed': "Consultation des preuves d'une alerte",
  'event.searched': "Recherche d'événements",
};

export function AdminPage() {
  const self = useOperator();
  const client = useQueryClient();
  const operators = useQuery({ queryKey: ['operators'], queryFn: () => api<OperatorRow[]>('/api/operators') });
  const audit = useQuery({ queryKey: ['audit'], queryFn: () => api<AuditRow[]>('/api/audit?limit=100'), refetchInterval: 30_000 });
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['operators'] }), client.invalidateQueries({ queryKey: ['audit'] })]);
  const onError = (failure: unknown) => {
    setError(failure instanceof ApiError ? failure.message : 'Une erreur est survenue.');
    setFields(failure instanceof ApiError ? (failure.fields ?? {}) : {});
  };
  const create = useMutation({ mutationFn: (body: Record<string, FormDataEntryValue | null>) => api('/api/operators', { body }), onSuccess: refresh, onError });
  const update = useMutation({ mutationFn: ({ id, ...body }: { id: string; role?: Role; disabled?: boolean }) => api(`/api/operators/${id}`, { method: 'PATCH', body }), onSuccess: refresh, onError });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError(null);
    setFields({});
    create.mutate({ email: data.get('email'), name: data.get('name'), role: data.get('role'), password: data.get('password') }, { onSuccess: () => form.reset() });
  };

  return (
    <>
      <PageHeader title="Administration" meta="Qui a accès à Sentinel, avec quel rôle, et ce que chacun a fait." />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Card title="Opérateurs">
        {operators.isPending ? (
          <Loading />
        ) : operators.isError ? (
          <ErrorState error={operators.error} retry={() => operators.refetch()} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Opérateurs</caption>
              <thead>
                <tr>
                  <th scope="col">Nom</th>
                  <th scope="col">Adresse</th>
                  <th scope="col">Rôle</th>
                  <th scope="col">Double authentification</th>
                  <th scope="col">Dernière connexion</th>
                  <th scope="col">Accès</th>
                </tr>
              </thead>
              <tbody>
                {operators.data.map((operator) => (
                  <tr key={operator.id}>
                    <td>
                      {operator.name}
                      {operator.id === self.id && <span className="muted"> (vous)</span>}
                    </td>
                    <td className="mono">{operator.email}</td>
                    <td>
                      <select
                        aria-label={`Rôle de ${operator.name}`}
                        value={operator.role}
                        disabled={update.isPending}
                        onChange={(event) => update.mutate({ id: operator.id, role: event.target.value as Role })}
                      >
                        {(Object.keys(roleLabels) as Role[]).map((role) => (
                          <option key={role} value={role}>
                            {roleLabels[role]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{operator.totpEnabled ? 'Activée' : 'À activer à la première connexion'}</td>
                    <td className="nowrap">
                      <Timestamp value={operator.lastLoginAt} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: operator.id, disabled: !operator.disabled })}
                      >
                        {operator.disabled ? 'Réactiver' : 'Désactiver'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Ajouter un opérateur">
        <form className="form form-grid" onSubmit={submit}>
          <label className="field">
            <span>Nom</span>
            <input name="name" required maxLength={100} aria-invalid={!!fields.name} />
            {fields.name && <span className="field-error">{fields.name}</span>}
          </label>
          <label className="field">
            <span>Adresse email</span>
            <input name="email" type="email" required autoComplete="off" aria-invalid={!!fields.email} />
            {fields.email && <span className="field-error">{fields.email}</span>}
          </label>
          <label className="field">
            <span>Rôle</span>
            <select name="role" defaultValue="analyst">
              {(Object.keys(roleLabels) as Role[]).map((role) => (
                <option key={role} value={role}>
                  {roleLabels[role]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Mot de passe provisoire (12 caractères au moins)</span>
            <input name="password" type="password" required minLength={12} autoComplete="new-password" aria-invalid={!!fields.password} />
            {fields.password && <span className="field-error">{fields.password}</span>}
          </label>
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            Ajouter l'opérateur
          </button>
        </form>
        <p className="muted note">La double authentification est activée par l'opérateur à sa première connexion.</p>
      </Card>

      <Card title="Journal des actions">
        {audit.isPending ? (
          <Loading />
        ) : audit.isError ? (
          <ErrorState error={audit.error} retry={() => audit.refetch()} />
        ) : audit.data.length === 0 ? (
          <Empty>Aucune action enregistrée.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table table-dense">
              <caption className="sr-only">Journal des actions des opérateurs</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Opérateur</th>
                  <th scope="col">Action</th>
                  <th scope="col">Cible</th>
                  <th scope="col">Adresse IP</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap">
                      <Timestamp value={row.at} absolute />
                    </td>
                    <td>{row.operator ?? <span className="muted">Système ou script</span>}</td>
                    <td>{actionLabels[row.action] ?? <span className="mono">{row.action}</span>}</td>
                    <td className="mono">{row.targetType ? `${row.targetType} ${row.targetId?.slice(0, 8) ?? ''}` : '—'}</td>
                    <td className="mono">{row.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
