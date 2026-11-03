/** Les valeurs de clés et les adresses email n'ont pas à finir dans les journaux : `Key (id)=(…) already exists`. */
export function redact(text: string): string {
  return text.replace(/=\([^)]*\)/g, '=(…)').replace(/[^\s"'`<>()=,;]+@[^\s"'`<>()=,;]+/g, '…@…');
}

/**
 * Journalise une erreur sans ses données : nom, code et message expurgés, jamais `detail`, `where` ni la pile.
 * Les erreurs PostgreSQL portent la ligne fautive dans ces champs.
 */
export function logError(context: string, error: unknown): void {
  if (!(error instanceof Error)) return console.error(context, typeof error);
  const code = (error as { code?: unknown }).code;
  console.error(context, `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${redact(error.message).slice(0, 500)}`);
}
