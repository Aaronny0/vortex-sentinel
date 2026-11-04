/** Début d'une empreinte de compte, assez pour distinguer les comptes à l'écran, jamais l'adresse elle-même. */
export const account = (emailHash: string) => `compte ${emailHash.slice(0, 8)}`;

/** Accord simple : « 1 échec », « 12 échecs ». */
export const count = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value > 1 ? plural : singular}`;
