import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En développement, l'API de Sentinel tourne sur le port 4100. Le proxy présente l'origine du tableau de bord
// (DASHBOARD_ORIGIN par défaut) : le serveur, seule autorité, continue de vérifier l'origine de chaque écriture.
const api = { target: 'http://127.0.0.1:4100', headers: { origin: 'http://localhost:4100' } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, proxy: { '/api': api, '/health': api } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
