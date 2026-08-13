# API OCR Assurance Maladie Tunisie

API d'extraction OCR intelligente pour les dossiers medicaux d'assurance maladie en Tunisie. Analyse les bulletins de soins, ordonnances, factures et autres documents justificatifs via Google Gemini avec auto-correction croisee multi-documents.

## Stack technique

- **Runtime** : [Cloudflare Workers](https://workers.cloudflare.com/)
- **Framework** : [Hono](https://hono.dev/)
- **IA / OCR** : [Google Generative AI](https://ai.google.dev/) — Gemini 3.1 Pro Preview
- **Base de donnees** : [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite distribue)
- **Langage** : JavaScript (ES Modules)

## Structure du projet

```
src/
  index.js          # Point d'entree — routes API + prompts OCR (PROMPT, PROMPT_DOSSIER, OCR_PROMPT)
  admin.js          # Plateforme d'administration (dashboard HTML, stats, logs, providers OCR)
  admin_panel.js    # Interface visuelle simplifiee du dashboard
  stats.js          # Module de statistiques et logging D1
wrangler.toml       # Configuration Cloudflare Workers (dev, staging, prod)
package.json        # Dependances npm
```

## Installation

```bash
git clone https://github.com/devfactory-ai/ocr-api-cloudflare.git
cd ocr-api-cloudflare
npm install
```

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Cle API Google Generative AI |
| `ADMIN_KEY` | Cle d'acces a la plateforme d'administration (optionnel en dev) |

## Environnements

| Env | Worker | D1 Database |
|-----|--------|-------------|
| **dev** | `ocr-api-bh-assurance-dev` | `bulletins-db-dev` |
| **staging** | `ocr-api-bh-assurance-staging` | `bulletins-db` |
| **prod** | `ocr-api-bh-assurance` | `bulletins-db-prod` |

## Commandes

```bash
# Developpement local (port 8787)
npm run dev

# Port personnalise
npx wrangler dev --port 8000

# Deployer sur staging
npx wrangler deploy --env staging

# Deployer en production
npx wrangler deploy --env prod
```

## Endpoints API

### `GET /`

Statut de l'API et liste des endpoints disponibles.

---

### `POST /analyse-bulletin` — Analyse OCR multi-documents (principal)

Endpoint principal. Envoie un ou plusieurs fichiers (bulletin + pieces justificatives) pour extraction OCR structuree avec auto-correction croisee.

- **Content-Type** : `multipart/form-data`
- **Champ** : `files` (un ou plusieurs fichiers image)
- Si 1 fichier → utilise le prompt simple (`PROMPT`)
- Si plusieurs fichiers → utilise le prompt multi-documents (`PROMPT_DOSSIER`) avec croisement inter-documents

**Exemple avec curl :**
```bash
curl -X POST https://votre-api.workers.dev/analyse-bulletin \
  -F "files=@bulletin_recto.jpg" \
  -F "files=@bulletin_verso.jpg" \
  -F "files=@ordonnance.jpg" \
  -F "files=@facture_pharmacie.jpg"
```

**Reponse :**
```json
{
  "success": true,
  "nombre_fichiers": 4,
  "resultat": {
    "infos_adherent": {
      "assureur_detecte": "CARTE Assurances",
      "nom_prenom": "Ben Aoun Mohamed",
      "numero_adherent": "1099",
      "numero_cnam": "0833",
      "employeur": "SEPTEO",
      "numero_bulletin": "BS-2026-0456",
      "date_bulletin": "06/07/2026",
      "beneficiaire_coche": "Conjoint"
    },
    "infos_patient": {
      "nom_prenom_malade": "Kefi Raouia"
    },
    "actes_independants": [ ... ],
    "cnam": { ... },
    "pieces_justificatives": [ ... ],
    "synthese": {
      "total_medecin": "160.000",
      "total_radiologie": "0",
      "total_pharmacie": "231.604",
      "total_laboratoire": "28.676",
      "total_hospitalisation": "883.306",
      "total_dentaire": "0",
      "total_optique": "0",
      "total_paramedical": "0",
      "total_global_calcule": "1303.586",
      "total_cnam": "0",
      "devise": "DT"
    }
  }
}
```

---

### `POST /ocr` — OCR simple (un seul document)

Analyse generique d'un document de sante unique (ordonnance, note labo, etc.). Retourne un JSON structure libre.

- **Content-Type** : `multipart/form-data`
- **Champ** : `file` (un seul fichier)

```bash
curl -X POST https://votre-api.workers.dev/ocr \
  -F "file=@document.jpg"
```

---

### `POST /valider` — Validation humaine

Permet a un superviseur de valider ou corriger le JSON extrait par l'IA, avec stockage en D1.

- **Content-Type** : `application/json`

```json
{
  "donnees_ia": { "...resultat de l'OCR..." },
  "metadata_validation": {
    "statut_validation": "valide",
    "erreurs_signalees": ["montant pharmacie incorrect"],
    "commentaires_correction": "Corrige le total"
  }
}
```

---

### `GET /bulletins` — Historique des validations

Retourne les 100 derniers bulletins valides/rejetes depuis D1.

### `GET /bulletins/:id` — Detail d'une validation

Retourne le detail d'un bulletin valide par son ID.

### `GET /docs` — Documentation Swagger

Interface Swagger UI interactive generee depuis `/openapi.json`.

### `GET /admin` — Tableau de bord administration

Dashboard avec statistiques d'utilisation, logs recents, gestion des providers OCR.
Protege par l'en-tete `X-Admin-Key` ou le query param `?admin_key=...`.

Sous-routes :
- `GET /admin/stats` — Statistiques JSON (filtrable par date)
- `GET /admin/logs` — Logs recents avec pagination
- `GET /admin/providers` — Liste des providers OCR configures
- `POST /admin/providers` — Ajouter un provider
- `PUT /admin/providers/:id` — Modifier un provider
- `DELETE /admin/providers/:id` — Supprimer un provider

---

## Assureurs supportes

L'API detecte automatiquement l'assureur via le logo et l'en-tete du bulletin :

- **BH Assurance**
- **CARTE Assurances**
- **CNAM** (Caisse Nationale d'Assurance Maladie)
- **STAR**, **GAT**, et tout autre assureur tunisien

## Types d'actes extraits

Tous les actes sont dans le tableau `actes_independants` avec un champ `type` :

| Type | Description | Lettre-cle CNAM |
|------|-------------|-----------------|
| `MEDECIN` | Consultations, visites | C, V, K, KC, KE |
| `RADIOLOGIE` | Echographie, scanner, IRM, radio | Rd, Z |
| `PHARMACIE` | Tickets/factures de pharmacie (avec `details_lignes`) | — |
| `LABORATOIRE` | Analyses biologiques (avec `details_lignes`) | B |
| `HOSPITALISATION` | Sejour clinique/hopital (`details_lignes` + `compte_autrui` separe) | KC |
| `DENTAIRE` | Soins dentaires DC / protheses DP (`type_soin_dentaire`) | D |
| `OPTIQUE` | Montures, verres, prescription OD/OG (`prescription_optique`) | — |
| `PARAMEDICAL` | Kine, sage-femme, infirmier | SC, SF, AMO, AMI, TO, TM |

## Pieces justificatives detectees

| Type | Description |
|------|-------------|
| `ORDONNANCE` | Prescription medicale (medicaments, posologie, duree) |
| `BILAN` | Resultats d'analyses biologiques (parametres, valeurs, normes) |
| `RECU` | Recu de paiement, ticket de caisse |
| `FACTURE` | Facture detaillee (pharmacie, labo, clinique) |
| `COMPTE_RENDU` | Compte-rendu medical, rapport radiologique |
| `LETTRE_CONFIDENTIELLE` | Lettre confidentielle de clinique (chirurgien, codification CNAM) |

Chaque piece est rattachee a l'acte correspondant via `rattachement_acte` (index dans `actes_independants`).

## Regles d'intelligence OCR (18 regles)

1. **Priorite au dactylographie** — les textes imprimes ecrasent l'ecriture manuscrite
2. **Cachets officiels** — noms et matricules fiscaux extraits des tampons
3. **Separation medecin/radiologie** — ne melange jamais les types
4. **Correction orthographique** — noms de medicaments corriges depuis les factures imprimees
5. **Regroupement obligatoire** — un acte pharmacie/labo = un ticket = un objet avec `details_lignes`
6. **Champs illisibles** — `[ILLISIBLE]` au lieu d'inventer
7. **Detection CNAM** — extraction automatique du decompte de remboursement
8. **Croisement CNAM / actes** — alimentation automatique de `montant_cnam`
9. **Pieces justificatives** — rattachement automatique aux actes correspondants
10. **Coherence ordonnance/pharmacie** — verification croisee des medicaments
11. **Numero de bulletin** — detection manuscrit/tampon (priorite haute)
12. **Date du bulletin** — format JJ/MM/AAAA
13. **Multi-pages** — fusion recto/verso d'un meme bulletin
14. **Beneficiaire** — detection case cochee (Adherent / Conjoint / Enfant)
15. **Lettres-cles CNAM** — extraction automatique sur tous les types d'actes
16. **Designations precises** — jamais de termes generiques quand le detail existe
17. **Regroupement pharmacie renforce** — fusion par pharmacie + date, verification finale anti-doublons
18. **Accord prealable (APB)** — detection sur documents separes et lignes APB dans les recus

## Modele IA

- **Modele** : `gemini-3.1-pro-preview`
- **Temperature** : `0.0` (extraction deterministe)
- **Format de reponse** : `application/json` (force)
- **Fallback** : systeme de retry automatique sur erreurs 429/500/503

## Base de donnees D1

Tables creees automatiquement au premier appel :

| Table | Description |
|-------|-------------|
| `bulletins_valides` | Bulletins valides/corriges par le superviseur |
| `usage_logs` | Logs d'utilisation (endpoint, provider, statut, duree, erreurs) |
| `ocr_providers` | Configuration des providers OCR |

## Gestion des erreurs

Format uniforme :

```json
{
  "success": false,
  "erreur": "Description de l'erreur"
}
```

| Code | Description |
|------|-------------|
| 200 | Extraction reussie |
| 422 | Aucun fichier envoye ou JSON mal forme |
| 500 | Erreur interne du serveur |
