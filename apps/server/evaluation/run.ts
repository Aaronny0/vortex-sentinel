// Évaluation de Sentinel (chapitre 7 du mémoire) : rejoue chaque scénario sur une base jetable, horloge simulée, moteur
// réel toutes les 30 s, et mesure détection, délai et faux positifs. Ne touche jamais une base contenant des données.
//   bun run evaluate            (écrit docs/evaluation-resultats.md)
import { writeFileSync } from 'node:fs';
import { manualClock } from '../src/common/clock.ts';
import { ensurePartitions } from '../src/db/pools.ts';
import { runEngineCycle } from '../src/engine/engine.ts';
import { storeBatch } from '../src/ingest/store.ts';
import { rules } from '../src/rules/registry.ts';
import { createTestDb } from '../test/db.ts';
import { scenarios, type Scenario } from './scenarios.ts';

const ENGINE_STEP = 30_000;
const WARMUP = 15 * 60_000;
const graceOf = Object.fromEntries(rules.map((rule) => [rule.id, rule.graceMs]));

type Outcome = {
  scenario: Scenario;
  detections: { rule: string; delaySeconds: number | null; severity: string }[];
  falsePositives: { rule: string; severity: string; summary: string }[];
  missed: string[];
  durationMs: number;
};

const db = await createTestDb();
const results: Outcome[] = [];
try {
  await ensurePartitions(db.appPool, manualClock('2026-09-01T00:00:00Z'), 5);
  for (const scenario of scenarios) {
    const started = performance.now();
    await db.admin.query(
      'TRUNCATE sentinel.event, sentinel.event_key, sentinel.notification, sentinel.incident_history, sentinel.incident_alert, sentinel.incident, sentinel.alert, sentinel.rule_checkpoint',
    );
    const t0 = Date.parse(scenario.id === 'S13' ? '2026-11-02T00:00:00Z' : '2026-11-02T10:00:00Z');
    const events = scenario.events(t0).sort((a, b) => a.at - b.at);
    const start = t0 - WARMUP;
    // Historique antérieur à la simulation : enregistré tel quel, à son heure de réception.
    let next = 0;
    while (next < events.length && events[next]!.at < start) {
      await storeBatch(db.ingestPool, [events[next]!.event], new Date(events[next]!.at));
      next += 1;
    }
    const clock = manualClock(new Date(start));
    const step = scenario.stepMs ?? ENGINE_STEP;
    for (let now = start; now <= t0 + scenario.durationMs; now += step) {
      clock.set(new Date(now));
      while (next < events.length && events[next]!.at <= now) {
        await storeBatch(db.ingestPool, [events[next]!.event], new Date(events[next]!.at));
        next += 1;
      }
      await runEngineCycle(db.appPool, rules, clock, (rule, error) => console.error(`${scenario.id} ${rule.id} :`, error));
    }
    const { rows } = await db.admin.query<{ rule_id: string; first_seen_at: Date; severity: string; summary: string }>(
      `SELECT DISTINCT ON (rule_id) rule_id, first_seen_at, severity, summary FROM sentinel.alert ORDER BY rule_id, first_seen_at`,
    );
    const fired = new Map(rows.map((row) => [row.rule_id, row]));
    results.push({
      scenario,
      detections: scenario.expected
        .filter((rule) => fired.has(rule))
        .map((rule) => {
          const row = fired.get(rule)!;
          // Détecté au cycle qui a créé l'alerte : instant évalué + délai de grâce de la règle.
          const detectedAt = row.first_seen_at.getTime() + (graceOf[rule] ?? 0);
          return { rule, severity: row.severity, delaySeconds: Math.round((detectedAt - (t0 + scenario.conditionMetAt[rule]!)) / 1000) };
        }),
      falsePositives: rows.filter((row) => !scenario.expected.includes(row.rule_id)).map((row) => ({ rule: row.rule_id, severity: row.severity, summary: row.summary })),
      missed: scenario.expected.filter((rule) => !fired.has(rule)),
      durationMs: performance.now() - started,
    });
    const last = results.at(-1)!;
    console.log(
      `${scenario.id} ${scenario.name} : ${last.detections.map((d) => `${d.rule} en ${d.delaySeconds} s`).join(', ') || 'aucune détection'}` +
        `${last.missed.length ? ` · manquées : ${last.missed.join(', ')}` : ''}${last.falsePositives.length ? ` · faux positifs : ${last.falsePositives.map((f) => f.rule).join(', ')}` : ''}`,
    );
  }
} finally {
  await db.drop();
}

const expectedTotal = results.reduce((sum, result) => sum + result.scenario.expected.length, 0);
const detectedTotal = results.reduce((sum, result) => sum + result.detections.length, 0);
const falsePositiveTotal = results.reduce((sum, result) => sum + result.falsePositives.length, 0);
const delays = results.flatMap((result) => result.detections.map((detection) => detection.delaySeconds!)).sort((a, b) => a - b);
const median = delays.length ? delays[Math.floor(delays.length / 2)]! : 0;
const labels: Record<string, string> = { critical: 'critique', high: 'élevée', medium: 'moyenne', low: 'faible', info: 'info' };

const lines = [
  '# Résultats de l’évaluation de Sentinel',
  '',
  `Produit par \`bun run evaluate\` (apps/server/evaluation) le ${new Date().toISOString().slice(0, 10)}. Données fictives, base jetable, horloge`,
  'simulée ; moteur réel évalué toutes les 30 s (10 min pour la semaine normale, 5 min et 1 min pour les scénarios longs).',
  '',
  `- **Taux de détection** : ${detectedTotal} règles attendues détectées sur ${expectedTotal} (${Math.round((detectedTotal / expectedTotal) * 100)} %).`,
  `- **Faux positifs** : ${falsePositiveTotal}, dont ${results.find((result) => result.scenario.id === 'S13')?.falsePositives.length ?? 0} sur une semaine d’activité normale simulée.`,
  `- **Délai de détection** : médiane ${median} s, maximum ${delays.at(-1) ?? 0} s, mesuré entre l’événement qui remplit la condition et le cycle du moteur qui crée l’alerte.`,
  '',
  '| Scénario | Règles attendues | Détection (gravité, délai) | Faux positifs |',
  '|---|---|---|---|',
  ...results.map(
    (result) =>
      `| ${result.scenario.id} · ${result.scenario.name} | ${result.scenario.expected.join(', ') || 'aucune'} | ${
        [...result.detections.map((detection) => `${detection.rule} (${labels[detection.severity]}, ${detection.delaySeconds} s)`), ...result.missed.map((rule) => `**${rule} manquée**`)].join(', ') || '—'
      } | ${result.falsePositives.map((fp) => `${fp.rule} (${labels[fp.severity]})`).join(', ') || 'aucun'} |`,
  ),
  '',
  '## Lecture',
  '',
  '- Le délai inclut le délai de grâce de 60 s des règles qui lisent les événements de Vortex (lots en retard de',
  '  l’émetteur) et l’attente du cycle suivant (30 s au plus). Les règles de sondes (R01, R15, R17) n’ont pas de délai de',
  '  grâce.',
  '- Pour un scénario long, le pas du moteur est plus grand que 30 s : le délai mesuré est alors majoré d’autant.',
  '- Faux positif : alerte d’une règle non attendue dans le scénario. La semaine normale mesure le bruit d’une boutique',
  '  ordinaire (connexions quotidiennes, erreurs de saisie occasionnelles, ventes, remboursements isolés, petits écarts).',
  '',
];
writeFileSync(new URL('../../../docs/evaluation-resultats.md', import.meta.url), `${lines.join('\n')}\n`);
console.log(`\nDétection ${detectedTotal}/${expectedTotal}, faux positifs ${falsePositiveTotal}, délai médian ${median} s. Résultats : docs/evaluation-resultats.md`);
