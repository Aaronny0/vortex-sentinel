import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError, type Operator, type Role } from './lib/api.ts';

const SessionContext = createContext<Operator | null>(null);

export const sessionQuery = {
  queryKey: ['session'],
  queryFn: async () => {
    try {
      return (await api<{ operator: Operator }>('/api/session')).operator;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  staleTime: 60_000,
} as const;

export function useSessionQuery() {
  return useQuery(sessionQuery);
}

export function SessionProvider({ operator, children }: { operator: Operator; children: ReactNode }) {
  return <SessionContext.Provider value={operator}>{children}</SessionContext.Provider>;
}

export function useOperator(): Operator {
  const operator = useContext(SessionContext);
  if (!operator) throw new Error('Session absente.');
  return operator;
}

/** Affichage seulement : le serveur refuse de toute façon ce que le rôle ne permet pas. */
export const can = (role: Role, allowed: Role[]) => allowed.includes(role);

export function useLogout() {
  const client = useQueryClient();
  return async () => {
    await api('/api/session/logout', { body: {} }).catch(() => undefined);
    client.clear();
    client.setQueryData(sessionQuery.queryKey, null);
  };
}
