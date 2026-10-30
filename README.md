# Maille

Backtest d'un bot de grille spot BTC-USDT sur l'historique public OKX, d'octobre 2017 à aujourd'hui.

Le but est de trouver des paramètres de grille qui tiennent dans le temps, sans regarder le futur pour choisir la zone.

## Fichiers

- `src/lib/grid/engine.ts` — moteur : allocation OKX, frais, stop, objectif, trailing haut/bas, réinvestissement des profits, historique de la grille.
- `src/lib/grid/engine.test.ts` — tests.
- `src/lib/okx.ts` — chandeliers publics OKX.
- `src/lib/format.ts` — formatage français.
- `src/components/maille-app.tsx` — interface, propositions, lecture dans le temps.
- `src/routes/` — page et coquille.
- `src/styles.css` — thème.
- `public/favicon.svg`

Les propositions de grille sont calées sur le premier cours de la fenêtre. Le classement rejoue ensuite tout l'historique.

Lecture : un curseur (et un bouton Lecture) montre la grille telle qu'elle était à cette date, avec un point à chaque déplacement vers le haut ou vers le bas.

Réinvestir les profits augmente la taille des ordres après chaque cycle gagnant.
