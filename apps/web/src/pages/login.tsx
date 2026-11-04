import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError, type Operator } from '../lib/api.ts';
import { sessionQuery } from '../session.tsx';

type Step = { kind: 'credentials' } | { kind: 'totp'; challenge: string } | { kind: 'enroll'; challenge: string; secret: string; uri: string };

/** Clé lisible par groupes de 4 pour la saisie manuelle dans l'application d'authentification. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

export function LoginPage() {
  const client = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setPending(true);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Une erreur est survenue.');
      if (failure instanceof ApiError && failure.code === 'CHALLENGE_EXPIRED') setStep({ kind: 'credentials' });
    } finally {
      setPending(false);
    }
  };

  const submitCredentials = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const result = await api<{ step: 'totp'; challenge: string } | { step: 'enroll'; challenge: string; enrollment: { secret: string; uri: string } }>('/api/session/login', {
        body: { email: form.get('email'), password: form.get('password') },
      });
      setStep(result.step === 'enroll' ? { kind: 'enroll', challenge: result.challenge, ...result.enrollment } : { kind: 'totp', challenge: result.challenge });
    });
  };

  const submitCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind === 'credentials') return;
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    void run(async () => {
      const { operator } = await api<{ operator: Operator }>('/api/session/verify', { body: { challenge: step.challenge, code } });
      client.setQueryData(sessionQuery.queryKey, operator);
    });
  };

  return (
    <main className="login">
      <div className="login-panel">
        <div className="login-brand">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>Sentinel</span>
        </div>
        <h1>{step.kind === 'enroll' ? 'Activer la double authentification' : 'Connexion'}</h1>
        <p className="muted">Console de surveillance de Vortex. Accès réservé aux opérateurs.</p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {step.kind === 'credentials' ? (
          <form key="credentials" onSubmit={submitCredentials} className="form">
            <label className="field">
              <span>Adresse email</span>
              <input name="email" type="email" autoComplete="username" required autoFocus />
            </label>
            <label className="field">
              <span>Mot de passe</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="button button-primary" disabled={pending}>
              {pending ? 'Vérification…' : 'Continuer'}
            </button>
          </form>
        ) : (
          <form key={step.kind} onSubmit={submitCode} className="form">
            {step.kind === 'enroll' && (
              <ol className="enroll-steps">
                <li>
                  Dans votre application d'authentification (Aegis, Google Authenticator, Microsoft Authenticator…), ajoutez un compte avec
                  cette clé :
                  <code className="enroll-secret">{grouped(step.secret)}</code>
                  <a href={step.uri} className="link">
                    Ouvrir dans l'application
                  </a>
                </li>
                <li>Saisissez le code à 6 chiffres qu'elle affiche.</li>
              </ol>
            )}
            <label className="field">
              <span>Code à 6 chiffres</span>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
            </label>
            <button type="submit" className="button button-primary" disabled={pending}>
              {pending ? 'Vérification…' : step.kind === 'enroll' ? 'Activer et se connecter' : 'Se connecter'}
            </button>
            <button type="button" className="button button-ghost" onClick={() => setStep({ kind: 'credentials' })}>
              Changer de compte
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
