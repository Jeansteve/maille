# Maille

Backtest d'un bot de grille spot BTC-USDT sur l'historique public OKX.

## Fichiers

- `src/lib/grid/engine.ts` — moteur : niveaux arithmétiques ou géométriques, quantité égale de BTC par grille (modèle OKX), frais, stop, objectif, cycles, équité contre un achat conservé.
- `src/lib/grid/engine.test.ts` — tests (exemple OKX 10 000 USDT / 6 grilles, cycle, stop).
- `src/lib/okx.ts` — chandeliers publics OKX, BTC-USDT, 15m / 1H / 4H / 1D.
- `src/lib/format.ts` — formatage français.
- `src/components/maille-app.tsx` — interface.
- `src/routes/` — page et coquille.
- `src/styles.css` — thème.
- `public/favicon.svg`

Les données viennent de l'API publique OKX. Aucune clé de compte, aucun ordre réel.

Les routes importent aussi la coquille de l'application (auth, pont d'aperçu). Ce dépôt contient le code du backtester, pas cette coquille.
