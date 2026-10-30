# Maille

Backtest d'un bot de grille spot BTC-USDT sur l'historique public OKX, d'octobre 2017 à aujourd'hui.

## Fichiers

- `src/lib/grid/engine.ts` — moteur : niveaux arithmétiques ou géométriques, quantité égale de BTC par grille (modèle OKX), frais, stop, objectif, trailing haut, trailing bas, cycles, équité contre un achat conservé.
- `src/lib/grid/engine.test.ts` — tests (exemple OKX 10 000 USDT / 6 grilles, cycle, stop, trailing).
- `src/lib/okx.ts` — chandeliers publics OKX, BTC-USDT, 15m / 1H / 4H / 1D.
- `src/lib/format.ts` — formatage français.
- `src/components/maille-app.tsx` — interface.
- `src/routes/` — page et coquille.
- `src/styles.css` — thème.
- `public/favicon.svg`

Les données viennent de l'API publique OKX. Aucune clé de compte, aucun ordre réel.

Trailing haut : la grille entière monte d'un cran quand le cours dépasse le haut, jusqu'au plafond. Le stop monte avec elle, l'objectif reste fixe.
Trailing bas : la grille s'allonge vers le plancher. Le haut ne bouge pas. Le capital manquant est compté à part.
