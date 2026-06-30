# BetValue Analyzer Web

Version Web/PWA statique de l'application.

## Démarrage local

Depuis la racine du projet :

```powershell
& "C:\Users\solia\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 4173 -d web
```

Puis ouvrir :

```text
http://localhost:4173
```

## Source de données

La WebApp lit Firestore en anonyme :

- `cloud_results`
- `shared_results`
- `cloud_diagnostics/current`

Si Firebase refuse ou n'a aucune donnée exploitable, l'interface passe en aperçu local pour ne pas afficher un écran vide.

## Publication gratuite

Le workflow GitHub Pages `web-pages.yml` publie le dossier `web/` sans build Node.
