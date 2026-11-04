import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './lib/api.ts';
import { applyTheme, watchSystemTheme } from './lib/theme.ts';
import { router } from './router.tsx';
import { sessionQuery } from './session.tsx';
import './styles/tokens.css';
import './styles/app.css';

applyTheme();
watchSystemTheme();

const client: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // L'interrogation s'arrête quand l'onglet est caché (docs/frontend.md § 12).
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

// Session expirée pendant le travail : retour à l'écran de connexion, sans perdre l'adresse en cours.
client.getQueryCache().subscribe((event) => {
  const error = event.query.state.error;
  if (event.type === 'updated' && error instanceof ApiError && error.status === 401 && event.query.queryKey[0] !== 'session')
    client.setQueryData(sessionQuery.queryKey, null);
});

// Application installable (PWA) : le service worker garde l'interface, jamais les données (public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator)
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
