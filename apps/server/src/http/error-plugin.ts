import { Elysia } from 'elysia';
import { AppError, type ErrorBody } from '../common/errors.ts';
import { logError } from '../common/safe-log.ts';

const body = (code: string, error: string): ErrorBody => ({ code, error });

/** À installer en premier : un seul format d'erreur { code, error, fields? }, jamais de détail interne. */
export const errorPlugin = new Elysia({ name: 'error-plugin' }).onError({ as: 'global' }, ({ code, error, set }) => {
  set.headers['cache-control'] = 'no-store';
  if (error instanceof AppError) {
    set.status = error.status;
    return error.toBody();
  }
  switch (code) {
    case 'NOT_FOUND':
      set.status = 404;
      return body('NOT_FOUND', 'Ressource introuvable.');
    case 'PARSE':
      set.status = 400;
      return body('INVALID_BODY', 'Le corps de la requête est illisible.');
    default:
      logError('Erreur non gérée :', error);
      set.status = 500;
      return body('INTERNAL', 'Une erreur est survenue.');
  }
});
