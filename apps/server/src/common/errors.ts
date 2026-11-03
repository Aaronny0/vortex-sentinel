export type ErrorBody = { code: string; error: string; fields?: Record<string, string> };

/** Erreur attendue : statut HTTP, code stable et message en français destiné à l'appelant. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toBody(): ErrorBody {
    return { code: this.code, error: this.message, ...(this.fields ? { fields: this.fields } : {}) };
  }
}
