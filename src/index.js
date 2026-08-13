// src/index.js
// API OCR Assurance Maladie Tunisie — Cloudflare Workers + Hono
// Inclut la plateforme d'administration, D1 et l'OCR avancé multi-documents

import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "./admin.js"; // À supposer existant dans votre dossier
import { logUsageEvent } from "./stats.js"; // À supposer existant dans votre dossier

const app = new Hono();
app.use("/*", cors());

// ─────────────────────────────────────────────
// Initialisation automatique des tables D1
// ─────────────────────────────────────────────
let dbInitialized = false;

async function initDB(db) {
  if (dbInitialized || !db) return;
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS bulletins_valides (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        donnees_ia            TEXT    NOT NULL,
        statut_validation     TEXT    NOT NULL DEFAULT 'en_attente',
        erreurs_signalees     TEXT    NOT NULL DEFAULT '[]',
        commentaires_correction TEXT  NOT NULL DEFAULT '',
        created_at            DATETIME DEFAULT (datetime('now'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS usage_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint      TEXT    NOT NULL,
        provider      TEXT,
        status        TEXT    NOT NULL,
        nb_fichiers   INTEGER NOT NULL DEFAULT 1,
        duree_ms      INTEGER,
        error_message TEXT,
        created_at    DATETIME DEFAULT (datetime('now'))
      )`),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at DESC)`,
      ),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_status ON usage_logs(status)`,
      ),
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_usage_logs_endpoint ON usage_logs(endpoint)`,
      ),
      db.prepare(`CREATE TABLE IF NOT EXISTS ocr_providers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nom         TEXT    NOT NULL UNIQUE,
        type        TEXT    NOT NULL,
        api_key     TEXT,
        modele      TEXT,
        est_actif   INTEGER NOT NULL DEFAULT 1,
        config_json TEXT    NOT NULL DEFAULT '{}',
        created_at  DATETIME DEFAULT (datetime('now')),
        updated_at  DATETIME DEFAULT (datetime('now'))
      )`),
    ]);
    dbInitialized = true;
  } catch (e) {
    console.error("DB init error:", e.message);
  }
}

app.use("/*", async (c, next) => {
  if (c.env.DB) await initDB(c.env.DB);
  return next();
});

// Monter la plateforme d'administration
app.route("/admin", admin);

// ─────────────────────────────────────────────
// LE SUPER-PROMPT MULTI-DOCUMENTS (Auto-Correction & Classement)
// Utilisé pour POST /analyse-bulletin (plusieurs fichiers simultanés)
// ─────────────────────────────────────────────
const PROMPT = `Analyse ces images d'un bulletin de soins d'assurance maladie tunisien.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien.
Identifie l'assureur via le logo, l'en-tête, la mise en page ou toute mention visible.
Extrais avec précision TOUTES les informations visibles.

🔴 RÈGLES D'AUTO-CORRECTION ET RECROISEMENT :
1. Privilégie TOUJOURS les textes dactylographiés/imprimés (tickets de pharmacie, factures informatiques) pour écraser ou corriger l'écriture manuscrite brouillonne au recto des bulletins.
2. Pour les praticiens, sors leur Nom/Prénom et leur MATRICULE FISCALE (M.F) en te basant EXCLUSIVEMENT sur les Cachets Officiels/Tampons à l'encre s'ils sont lisibles.
3. Ne mélange PAS un "Médecin" (Consultation C, V) et un "Centre de RADIOLOGIE" (Echographie, Scanner, IRM). Utilise le bon "type" pour eux.
4. Répare l'orthographe des noms de médicaments selon les factures imprimées, si manuscritement le code ou nom est mal recopié.
5. REGROUPEMENT OBLIGATOIRE : Pour les actes de type "pharmacie" et "analyse biologique", regroupe TOUTES les lignes (médicaments ou analyses) d'un MÊME acte (même date, même pharmacie/labo) dans UN SEUL objet avec un tableau "details_lignes". Ne crée PAS un acte séparé par médicament ou par analyse.
6. ULTIME RECOURS : Si le manuscrit est indéchiffrable et sans référence imprimée sur un autre document, utilise la mention "[ILLISIBLE]". AUCUNE INVENTION.

🔵 DÉTECTION ET EXTRACTION DU DOCUMENT CNAM :
7. Si un document CNAM est présent (Décompte de remboursement des frais de soins de la Caisse Nationale d'Assurance Maladie), tu DOIS l'analyser et remplir le bloc "cnam" ci-dessous.
   - Le document CNAM peut se présenter sous différents formats : décompte imprimé, relevé de remboursement, bordereau CNAM, attestation de prise en charge, etc.
   - Identifie-le par les mots-clés : "CNAM", "Caisse Nationale d'Assurance Maladie", "Décompte de remboursement", "Mnt Remb", "Mnt à remb", "Total remboursé".
   - Extrais TOUTES les sections du décompte CNAM : Consultation & Visites, Actes, Médicaments, ou toute autre section présente.
   - Pour chaque ligne, extrais : désignation, date, montant dépensé, montant remboursé, décision médicale.
   - Extrais les totaux : total dépensé et total remboursé.
8. CROISEMENT CNAM ↔ ACTES : Si un décompte CNAM est présent, pour chaque acte dans "actes_independants", cherche la ligne CNAM correspondante (même type de soin, même date, même montant dépensé) et remplis le champ "montant_cnam" avec le montant remboursé CNAM correspondant. Si aucune correspondance → "montant_cnam": "".

🟢 EXTRACTION DES PIÈCES JUSTIFICATIVES (Ordonnances, Bilans, Reçus, etc.) :
9. Pour chaque document justificatif présent dans les images, extrais ses informations dans le tableau "pieces_justificatives".
   - Types de pièces à détecter :
     * "ORDONNANCE" : prescription médicale (médicaments prescrits, posologie, durée, médecin prescripteur)
     * "BILAN" : résultat d'analyse biologique / bilan sanguin / bilan médical (paramètres, valeurs, unités, normes)
     * "RECU" : reçu de paiement, ticket de caisse, quittance (montant payé, prestataire, date)
     * "FACTURE" : facture détaillée de pharmacie, labo, clinique (lignes, montants, TVA)
     * "COMPTE_RENDU" : compte-rendu médical, rapport radiologique, certificat médical
     * "LETTRE_CONFIDENTIELLE" : lettre confidentielle de clinique (chirurgien, date hospitalisation/opération, motif, codification CNAM lettre-clé + cotation — ex: "Son acte est codifié à Kc P1")
     * "AUTRE" : tout autre document justificatif non classifiable
   - Chaque pièce doit être rattachée à l'acte correspondant dans "actes_independants" via le champ "rattachement_acte" (index de l'acte dans le tableau, commençant à 0). Si aucun rattachement possible → null.
10. CROISEMENT ORDONNANCES ↔ PHARMACIE : Si une ordonnance prescrit des médicaments et qu'un ticket de pharmacie les liste, vérifie la cohérence : les médicaments délivrés correspondent-ils à la prescription ? Signale les écarts dans "observations".

🔴 NUMÉRO DE BULLETIN (PRIORITÉ HAUTE) :
11. Cherche un numéro écrit à la main ou tamponné (stylo ROUGE, BLEU ou NOIR, tampon encre) sur le recto ET le verso du bulletin.
   - Ne te fie PAS à la couleur pour identifier le numéro — fie-toi à sa POSITION (coin supérieur, marge, champ "N° BS") et son FORMAT (nombre seul ou code alphanumérique).
   - Peut être : un nombre seul (ex: 1234), un code alphanumérique (ex: BS-2024-0456), ou un tampon numéroté.
   - Regarde en HAUT du document (coin supérieur droit souvent), dans les marges, et sur TOUTES les pages.
   - Si plusieurs numéros sont visibles, privilégie celui dans le champ "N° Bulletin" / "N° BS" / "Réf".
   - NE JAMAIS confondre avec le numéro d'adhérent ou le numéro de contrat.

🔴 DATE DU BULLETIN :
12. Cherche la date sur le RECTO (champ "Date", en haut ou en bas) ET sur le VERSO (à côté de la signature).
   - Si plusieurs dates : la date du bulletin est celle du champ "Date" officiel, PAS la date des actes médicaux.
   - Format attendu : JJ/MM/AAAA. Si l'année est sur 2 chiffres (ex: 25), convertir en 2025.

🔴 LECTURE MULTI-PAGES :
13. Le bulletin a souvent 2 faces (recto + verso). Tu peux recevoir 2 images pour UN SEUL bulletin.
   - RECTO : informations adhérent (nom, prénom, n° adhérent, entreprise), actes médicaux, praticiens
   - VERSO : numéro de bulletin (souvent tamponné), cachet employeur, signature, date, observations
   - Si 2 images se ressemblent (même format de formulaire d'assurance — BH Assurance, CARTE Assurances, CNAM ou autre), ce sont probablement le RECTO et VERSO du même bulletin → FUSIONNER les informations.
   - Ne crée PAS 2 bulletins séparés pour le recto et verso d'un même document.

🔴 BÉNÉFICIAIRE (case cochée) :
14. Regarde les cases à cocher : □ Adhérent  □ Conjoint  □ Enfant
   - Une case cochée = ✓ ou ✗ ou remplie au stylo.
   - Si "Conjoint" est coché, le nom du malade est le CONJOINT (pas l'adhérent).
   - Si "Enfant" est coché, le nom du malade est l'ENFANT.
   - Si aucune case n'est clairement cochée, mettre "Adhérent" par défaut.

🔵 CODES CNAM ET LETTRES-CLÉS (pour auto-complétion côté plateforme) :
15. Pour chaque acte médical extrait, cherche à identifier la LETTRE-CLÉ CNAM si elle est visible sur le document :
   * KC = actes chirurgicaux (ex: KC50 pour une suture)
   * KE = actes d'explorations (endoscopie, biopsie)
   * K = actes techniques médicaux
   * Z = actes utilisant des radiations ionisantes
   * B = actes de biologie/analyses (ex: B10 pour groupe sanguin, B60 pour NFS)
   * Rd = actes de radiologie diagnostique
   * D = actes dentaires
   * P = actes d'anatomo-pathologie
   * SC, SF = actes de sages-femmes
   * AMO, AMI, AMS = actes infirmiers
   * TO, TM = actes de rééducation (kiné)
   - La cotation est le NOMBRE qui suit la lettre-clé (ex: dans "KC50", la lettre_cle est "KC" et la cotation est 50).
   - Sur les factures de laboratoire, la cotation est souvent visible (ex: "B40", "B60", "B127").
   - Sur les factures de radiologie, cherche le code Rd ou Z (ex: "Rd15", "Z30").
   - Sur les factures de chirurgie/clinique, cherche KC (ex: "KC50", "KC120").

🔵 DÉSIGNATIONS PRÉCISES :
16. NE JAMAIS utiliser des termes génériques comme "Acte Biologique", "Consommables", "Pharmacie Interne", "Forfait" quand la facture détaille les actes.
   - Lire CHAQUE LIGNE de la facture et extraire la désignation EXACTE telle qu'écrite (ex: "NUMÉRATION FORMULE SANGUINE", "GLYCÉMIE À JEUN", "ÉCHOGRAPHIE ABDOMINALE").
   - Si la facture est une facture globale d'hospitalisation/clinique avec des postes génériques (Consommables, Pharmacie Interne, Timbre Fiscal, Frais de séjour), extraire ces postes tels quels — ce sont des postes hospitaliers, pas des actes CNAM.
   - Pour les analyses biologiques : TOUJOURS détailler chaque analyse séparément dans details_lignes, avec sa cotation B si visible.
   - Pour la radiologie : TOUJOURS préciser le type exact (Échographie abdominale, Radio thorax face, Scanner cérébral...) plutôt que "Radiologie" ou "Imagerie".

🔵 REGROUPEMENT PHARMACIE RENFORCÉ :
17. UN acte PHARMACIE = UN ticket/facture d'UNE pharmacie à UNE date.
   - TOUTES les lignes du même ticket vont dans "details_lignes" avec pour chaque médicament : nom corrigé, code_amm si visible, quantité, prix unitaire, total ligne.
   - Le champ "montant" de l'acte = TOTAL du ticket.
   - Ne crée JAMAIS un acte PHARMACIE séparé par médicament.
   - VÉRIFICATION FINALE : Avant de retourner le JSON, vérifie qu'il n'y a pas 2 actes PHARMACIE avec la même pharmacie ET la même date. Si oui, fusionner leurs details_lignes dans UN SEUL acte et additionner les montants.

🔴 ACCORD PRÉALABLE (APB) :
18. Certains actes nécessitent un ACCORD PRÉALABLE de la CNAM avant d'être réalisés.
   - Indices de présence d'un accord préalable :
     * Document séparé intitulé "Accord préalable", "Décision de prise en charge", "Autorisation préalable", "APB"
     * Mention "Prise en charge" ou "Accord" dans le décompte CNAM (colonne décision)
     * Numéro de décision ou référence d'accord sur un document CNAM
     * Ligne "APB" dans un reçu ou facture de laboratoire (ex: ligne APB avec montant séparé sur un reçu labo)
   - Si un accord préalable est détecté pour un acte, mettre "accord_prealable": true dans cet acte.
   - Si aucun accord préalable n'est détecté → "accord_prealable": false.

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
          "infos_adherent": {
            "assureur_detecte": "BH Assurance | CARTE Assurances | CNAM | STAR | GAT | autre (détecté via logo/en-tête)",
            "nom_prenom": "Nom de l'adhérent",
            "numero_adherent": "N° de l'adhérent (N° contrat/police)",
            "numero_cnam": "N° CNAM de l'adhérent (champ N° CNAM / Adhésion N° sur le bulletin)",
            "employeur": "Nom de l'employeur (champ Employeur sur le bulletin)",
            "numero_bulletin": "N° du bulletin (PRIORITÉ HAUTE — chercher manuscrit, tampon, champ N° BS)",
            "date_bulletin": "Date du bulletin (JJ/MM/AAAA)",
            "beneficiaire_coche": "Conjoint / Enfant / Adhérent (case cochée, défaut: Adhérent)"
          },
          "infos_patient": {
            "nom_prenom_malade": "Nom du patient soigné"
          },
          "actes_independants": [
            {
              "type": "MEDECIN",
              "date": "...",
              "praticien": "Nom du médecin traitant",
              "matricule_fiscale": "...",
              "acte": "Désignation EXACTE (ex: Consultation spécialisée cardiologie, Visite à domicile)",
              "lettre_cle": "KC ou K ou KE ou C ou V si visible",
              "cotation": "Nombre après la lettre-clé (ex: 50 pour KC50)",
              "montant": "...",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "RADIOLOGIE",
              "date": "...",
              "centre_radiologie": "Nom du centre ou médecin radiologue",
              "matricule_fiscale": "...",
              "medecin_prescripteur": "Médecin ayant prescrit la radio",
              "acte": "Désignation EXACTE (ex: Échographie abdominale, Radio thorax face, Scanner cérébral)",
              "lettre_cle": "Rd ou Z si visible",
              "cotation": "Nombre après la lettre-clé (ex: 15 pour Rd15)",
              "montant": "...",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "PHARMACIE",
              "date": "...",
              "pharmacie": "...",
              "matricule_fiscale": "...",
              "details_lignes": [
                {
                  "medicament": "Nom EXACT du médicament (corrigé depuis facture imprimée)",
                  "code_amm": "Code AMM si visible",
                  "quantite": "...",
                  "prix_unitaire": "...",
                  "total_ligne": "..."
                }
              ],
              "montant": "TOTAL du ticket/facture pharmacie",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
           {
              "type": "LABORATOIRE",
              "date": "Date de l'analyse",
              "laboratoire": "Nom complet du labo",
              "matricule_fiscale": "MF du laboratoire",
              "medecin_prescripteur": "Nom du médecin",
              "details_lignes": [
                {
                  "acte": "Désignation EXACTE (ex: NUMÉRATION FORMULE SANGUINE, GLYCÉMIE À JEUN)",
                  "code_acte": "Code CNAM si visible (ex: BCA000010)",
                  "lettre_cle": "B",
                  "cotation": "Nombre (ex: 60 pour B60)",
                  "montant": "Montant de cette ligne"
                }
              ],
              "montant": "Montant Total facturé pour cet acte labo",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "HOSPITALISATION",
              "clinique": "Nom de la clinique/hôpital",
              "matricule_fiscale": "MF de la clinique",
              "date_entree": "Date d'entrée (JJ/MM/AAAA)",
              "date_sortie": "Date de sortie (JJ/MM/AAAA)",
              "motif": "Motif d'hospitalisation (accouchement, chirurgie, etc.)",
              "details_lignes": [
                {
                  "prestation": "Désignation EXACTE (ex: CHAMBRE INDIVIDUELLE, RCF CONTINUE, ASSISTANCE SAGE-FEMME)",
                  "quantite": "Quantité",
                  "prix_unitaire": "Prix unitaire",
                  "tva": "Taux TVA si visible",
                  "montant": "Montant HT ou TTC"
                }
              ],
              "compte_autrui": [
                {
                  "nom_prestataire": "Nom du prestataire externe (médecin, anesthésiste, pharmacie, labo)",
                  "matricule_fiscale": "MF du prestataire",
                  "nature_acte": "Nature de l'acte (Consultation, ANESTHESISTE, ACCOUCHEMENT, etc.)",
                  "montant": "Montant TTC"
                }
              ],
              "total_clinique": "Total des frais clinique propres",
              "total_compte_autrui": "Total compte d'autrui",
              "montant": "Total général de la facture (clinique + compte d'autrui)",
              "lettre_cle": "KC si visible (ex: KC pour accouchement)",
              "cotation": "Nombre après la lettre-clé si visible",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "DENTAIRE",
              "date": "Date de l'acte",
              "praticien": "Nom du dentiste",
              "matricule_fiscale": "MF du dentiste",
              "type_soin_dentaire": "DC pour SOINS DENTAIRES (partie haute du formulaire), DP pour PROTHESE DENTAIRE (partie basse)",
              "dents": "Numéros des dents traitées (ex: 11, 21, 36)",
              "acte": "Désignation EXACTE (ex: Détartrage, Extraction, Prothèse dentaire)",
              "lettre_cle": "D",
              "cotation": "Nombre après la lettre-clé (ex: 40 pour D40)",
              "montant": "Honoraires",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "OPTIQUE",
              "date": "Date de l'acte",
              "praticien": "Nom de l'opticien/lunettier",
              "matricule_fiscale": "MF de l'opticien",
              "acte": "Monture + Verres optiques",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE (ex: Monture optique, Verres progressifs, Traitement anti-reflet)",
                  "quantite": "Quantité",
                  "montant": "Montant"
                }
              ],
              "prescription_optique": {
                "oeil_droit": "Correction OD (ex: +0.25 (-0.25 à 5°))",
                "oeil_gauche": "Correction OG (ex: 0.00 (-0.50 à 175°))"
              },
              "montant": "Total TTC de la facture",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "PARAMEDICAL",
              "date": "Date de l'acte",
              "praticien": "Nom du praticien paramédical (kiné, sage-femme, infirmier)",
              "matricule_fiscale": "MF du praticien",
              "acte": "Désignation EXACTE (ex: Séance de rééducation, Soins infirmiers)",
              "lettre_cle": "SC ou SF ou AMO ou AMI ou AMS ou TO ou TM si visible",
              "cotation": "Nombre après la lettre-clé",
              "montant": "Honoraires",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            }
          ],
          "cnam": {
            "numero_assure": "N° de l'assuré CNAM",
            "caisse": "Nom de la caisse (ex: CNSS, CNRPS...)",
            "beneficiaire": "Bénéficiaire (ex: Conjoint - SAMIA, Adhérent...)",
            "regime": "Régime (ex: APCI/MLD, AMG...)",
            "ref_paiement": "Référence de paiement / Mandat",
            "date_decompte": "Date du décompte (JJ/MM/AAAA)",
            "details_remboursement": [
              {
                "categorie": "Consultation & Visites | Actes | Médicaments | autre section",
                "lignes": [
                  {
                    "code": "Code du produit/acte (si disponible)",
                    "designation": "Désignation de l'acte ou du médicament",
                    "quantite": "Quantité (si disponible)",
                    "date": "Date de l'acte",
                    "montant_depense": "Montant dépensé",
                    "montant_rembourse": "Montant remboursé par la CNAM",
                    "decision": "Décision médicale (Accord, Rejet, etc.)"
                  }
                ]
              }
            ],
            "total_depense": "Total dépensé (toutes sections)",
            "total_rembourse": "Total remboursé par la CNAM (toutes sections)"
          },
          "pieces_justificatives": [
            {
              "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | AUTRE",
              "rattachement_acte": 0,
              "praticien": "Nom du médecin/prescripteur",
              "date": "Date du document (JJ/MM/AAAA)",
              "contenu": {
                "medicaments_prescrits": [
                  {
                    "nom": "Nom du médicament",
                    "posologie": "Posologie prescrite",
                    "duree": "Durée du traitement",
                    "quantite": "Quantité prescrite"
                  }
                ],
                "resultats_bilan": [
                  {
                    "parametre": "Nom du paramètre (ex: Glycémie, Cholestérol...)",
                    "valeur": "Valeur mesurée",
                    "unite": "Unité (g/l, mmol/l...)",
                    "norme": "Valeurs normales de référence"
                  }
                ],
                "texte_libre": "Contenu textuel pour COMPTE_RENDU ou AUTRE (résumé fidèle)",
                "lettre_confidentielle": {
                  "clinique": "Nom de la clinique",
                  "chirurgien": "Nom du chirurgien",
                  "date_hospitalisation": "Date d'hospitalisation (JJ/MM/AAAA)",
                  "date_operation": "Date d'opération (JJ/MM/AAAA)",
                  "motif": "Motif (accouchement, chirurgie, etc.)",
                  "codification_cnam": "Codification CNAM complète (ex: Kc P1)",
                  "lettre_cle": "Lettre-clé extraite (ex: KC)",
                  "cotation": "Cotation extraite (ex: P1)"
                }
              },
              "montant": "Montant figurant sur la pièce (si applicable)",
              "observations": "Remarques : écarts ordonnance/pharmacie, anomalies détectées"
            }
          ],
          "synthese": {
            "total_medecin": "Somme Consultations ou 0",
            "total_radiologie": "Somme Actes Radio/Imagerie ou 0",
            "total_pharmacie": "Somme pharmacie ou 0",
            "total_laboratoire": "Total labo ou 0",
            "total_hospitalisation": "Total hospitalisation/clinique ou 0",
            "total_dentaire": "Total actes dentaires ou 0",
            "total_optique": "Total actes optique ou 0",
            "total_paramedical": "Total actes paramédicaux ou 0",
            "total_global_calcule": "La somme de tout le dossier",
            "total_cnam": "Total remboursé par la CNAM (depuis le décompte CNAM si présent, sinon 0)",
            "devise": "DT"
          }
        }

RÈGLES :
- "beneficiaire_coche" : lis la case cochée (✓, ✗, remplie au stylo) → "Adhérent", "Conjoint" ou "Enfant". Si aucune case clairement cochée → "Adhérent" par défaut.
- "conjoint.nom_prenom" : remplis UNIQUEMENT si case "Conjoint" cochée. Le nom du malade se trouve dans la section praticien du bulletin.
- "enfants" : remplis UNIQUEMENT si case "Enfant" cochée. Sinon tableau vide [].
- Chaque acte = un soin distinct.
- "pharmacie", "analyse" : remplis ces sous-objets UNIQUEMENT si les données correspondantes existent sur le document. Si pas de données → ne mets pas la clé.
- "cnam" : remplis ce bloc UNIQUEMENT si un document CNAM (décompte de remboursement) est présent dans les images. Si aucun document CNAM → ne mets pas la clé "cnam".
- "pieces_justificatives" : remplis ce tableau UNIQUEMENT si des documents justificatifs (ordonnances, bilans, reçus, factures, comptes-rendus, lettres confidentielles) sont présents dans les images. Si aucun → tableau vide []. Dans "contenu", remplis UNIQUEMENT les sous-clés pertinentes au type de pièce : "medicaments_prescrits" pour ORDONNANCE, "resultats_bilan" pour BILAN, "lettre_confidentielle" pour LETTRE_CONFIDENTIELLE, "texte_libre" pour COMPTE_RENDU/AUTRE. Supprime les sous-clés non pertinentes.
- "assureur_detecte" : identifie l'assureur via le logo, l'en-tête, la mise en page. Si non identifiable → "".
- "numero_cnam" : cherche le champ "N° CNAM" ou "Adhésion N°" sur le bulletin. Distinct du "numero_adherent". Si non visible → "".
- "employeur" : cherche le champ "Employeur" sur le bulletin. Si non visible → "".
- "lettre_cle" et "cotation" : remplis sur TOUS les types d'actes (MEDECIN, RADIOLOGIE, LABORATOIRE, HOSPITALISATION, DENTAIRE, PARAMEDICAL) si la lettre-clé CNAM est visible sur le document (facture, reçu, bulletin, lettre confidentielle). Si non visible → "". Ne jamais inventer de cotation.
- Pour HOSPITALISATION : "compte_autrui" est un tableau SÉPARÉ de "details_lignes". Les prestataires externes (médecins, anesthésiste, pharmacie, labo) vont dans "compte_autrui". Les prestations propres à la clinique (chambre, sage-femme, pharmacie interne) vont dans "details_lignes".
- Pour DENTAIRE : le formulaire dentaire tunisien a 2 sections — "SOINS DENTAIRES" (soins conservateurs = DC) et "PROTHESE DENTAIRE" (prothèses = DP). Remplir "type_soin_dentaire" avec "DC" ou "DP" selon la section. Cette distinction est critique pour le calcul des plafonds. Extrais les numéros de dents du diagramme dentaire si visible. Lettre-clé = D.
- Pour OPTIQUE : quand le prestataire est un opticien/lunettier ou que la facture contient montures/verres, utiliser type "OPTIQUE" (JAMAIS "PARAMEDICAL"). Séparer chaque ligne de la facture (monture, verres, traitements) dans "details_lignes". Si une ordonnance ophtalmologique est présente avec des corrections OD/OG, remplir "prescription_optique".
- Pour PARAMEDICAL : lettre-clé = SC/SF pour sages-femmes, AMO/AMI/AMS pour infirmiers, TO/TM pour kiné.
- NE JAMAIS inventer de données. Si pas visible → "".
- Les noms sont tunisiens. "nekk" → "Mekki", "nohaned" → "Mohamed".
- "matricule_fiscale" : format tunisien 7 chiffres + lettre + 3 caractères. NE JAMAIS inventer.
Si des champs sont introuvables, indique "". N'ajoute pas de balises de code Markdown.`;

// ─────────────────────────────────────────────
// PROMPT DOSSIER MULTI-DOCUMENTS
// Utilisé quand plusieurs fichiers sont envoyés
// ─────────────────────────────────────────────
const PROMPT_DOSSIER = `Tu reçois plusieurs images qui font partie du MÊME dossier médical d'un adhérent d'assurance maladie en Tunisie.
Le bulletin peut provenir de différents assureurs : BH Assurance, CARTE Assurances, CNAM, STAR, GAT, ou tout autre assureur tunisien. Identifie l'assureur via le logo, l'en-tête ou toute mention visible.
Ces images peuvent inclure : un bulletin de soins, des reçus, des ordonnances, des résultats d'analyse, des factures, un décompte CNAM, etc.

Tu dois COMBINER toutes ces images pour produire UN SEUL dossier structuré et complet.

🔴 RÈGLES D'AUTO-CORRECTION ET RECROISEMENT :
1. Privilégie TOUJOURS les textes dactylographiés/imprimés (tickets de pharmacie, factures informatiques) pour écraser ou corriger l'écriture manuscrite brouillonne au recto des bulletins.
2. Pour les praticiens, sors leur Nom/Prénom et leur MATRICULE FISCALE (M.F) en te basant EXCLUSIVEMENT sur les Cachets Officiels/Tampons à l'encre s'ils sont lisibles.
3. Ne mélange PAS un "Médecin" (Consultation C, V) et un "Centre de RADIOLOGIE" (Echographie, Scanner, IRM). Utilise le bon "type" pour eux.
4. Répare l'orthographe des noms de médicaments selon les factures imprimées, si manuscritement le code ou nom est mal recopié.
5. REGROUPEMENT OBLIGATOIRE : Pour PHARMACIE et LABORATOIRE, regroupe TOUTES les lignes (médicaments ou analyses) d'un MÊME acte (même date, même pharmacie/labo) dans UN SEUL objet avec un tableau "details_lignes". Ne crée PAS un objet séparé par médicament ou par analyse.
6. ULTIME RECOURS : Si le manuscrit est indéchiffrable et sans référence imprimée sur un autre document, utilise la mention "[ILLISIBLE]". AUCUNE INVENTION.

🔵 DÉTECTION ET EXTRACTION DU DOCUMENT CNAM :
7. Si un document CNAM est présent parmi les images (Décompte de remboursement des frais de soins de la Caisse Nationale d'Assurance Maladie), tu DOIS l'analyser et remplir le bloc "cnam" ci-dessous.
   - Le document CNAM peut se présenter sous différents formats : décompte imprimé, relevé de remboursement, bordereau CNAM, attestation de prise en charge, notification de remboursement, etc.
   - Identifie-le par les mots-clés : "CNAM", "Caisse Nationale d'Assurance Maladie", "Décompte de remboursement", "Mnt Remb", "Mnt à remb", "Total remboursé", "TotRemb".
   - Extrais TOUTES les sections du décompte CNAM : Consultation & Visites, Actes, Médicaments, ou toute autre section présente sur le document.
   - Pour chaque ligne, extrais : code (si dispo), désignation, quantité (si dispo), date, montant dépensé, montant remboursé, décision médicale.
   - Extrais les totaux : total dépensé et total remboursé.
8. CROISEMENT CNAM ↔ ACTES : Si un décompte CNAM est présent, pour chaque acte dans "actes_independants", cherche la ligne CNAM correspondante (même type de soin, même date, même montant dépensé) et remplis le champ "montant_cnam" avec le montant remboursé CNAM correspondant. Si aucune correspondance → "montant_cnam": "".

🟢 EXTRACTION DES PIÈCES JUSTIFICATIVES (Ordonnances, Bilans, Reçus, etc.) :
9. Pour chaque document justificatif présent dans les images, extrais ses informations dans le tableau "pieces_justificatives".
   - Types de pièces à détecter :
     * "ORDONNANCE" : prescription médicale (médicaments prescrits, posologie, durée, médecin prescripteur)
     * "BILAN" : résultat d'analyse biologique / bilan sanguin / bilan médical (paramètres, valeurs, unités, normes)
     * "RECU" : reçu de paiement, ticket de caisse, quittance (montant payé, prestataire, date)
     * "FACTURE" : facture détaillée de pharmacie, labo, clinique (lignes, montants, TVA)
     * "COMPTE_RENDU" : compte-rendu médical, rapport radiologique, certificat médical
     * "LETTRE_CONFIDENTIELLE" : lettre confidentielle de clinique (chirurgien, date hospitalisation/opération, motif, codification CNAM lettre-clé + cotation — ex: "Son acte est codifié à Kc P1")
     * "AUTRE" : tout autre document justificatif non classifiable
   - Chaque pièce doit être rattachée à l'acte correspondant dans "actes_independants" via le champ "rattachement_acte" (index de l'acte dans le tableau, commençant à 0). Si aucun rattachement possible → null.
10. CROISEMENT ORDONNANCES ↔ PHARMACIE : Si une ordonnance prescrit des médicaments et qu'un ticket de pharmacie les liste, vérifie la cohérence : les médicaments délivrés correspondent-ils à la prescription ? Signale les écarts dans "observations".

🔴 NUMÉRO DE BULLETIN (PRIORITÉ HAUTE) :
11. Cherche un numéro écrit à la main ou tamponné (stylo ROUGE, BLEU ou NOIR, tampon encre) sur le recto ET le verso du bulletin.
   - Ne te fie PAS à la couleur pour identifier le numéro — fie-toi à sa POSITION (coin supérieur, marge, champ "N° BS") et son FORMAT (nombre seul ou code alphanumérique).
   - Peut être : un nombre seul (ex: 1234), un code alphanumérique (ex: BS-2024-0456), ou un tampon numéroté.
   - Regarde en HAUT du document (coin supérieur droit souvent), dans les marges, et sur TOUTES les pages.
   - Si plusieurs numéros sont visibles, privilégie celui dans le champ "N° Bulletin" / "N° BS" / "Réf".
   - NE JAMAIS confondre avec le numéro d'adhérent ou le numéro de contrat.

🔴 DATE DU BULLETIN :
12. Cherche la date sur le RECTO (champ "Date", en haut ou en bas) ET sur le VERSO (à côté de la signature).
   - Si plusieurs dates : la date du bulletin est celle du champ "Date" officiel, PAS la date des actes médicaux.
   - Format attendu : JJ/MM/AAAA. Si l'année est sur 2 chiffres (ex: 25), convertir en 2025.

🔴 LECTURE MULTI-PAGES :
13. Le bulletin a souvent 2 faces (recto + verso). Tu peux recevoir 2 images pour UN SEUL bulletin.
   - RECTO : informations adhérent (nom, prénom, n° adhérent, entreprise), actes médicaux, praticiens
   - VERSO : numéro de bulletin (souvent tamponné), cachet employeur, signature, date, observations
   - Si 2 images se ressemblent (même format de formulaire d'assurance — BH Assurance, CARTE Assurances, CNAM ou autre), ce sont probablement le RECTO et VERSO du même bulletin → FUSIONNER les informations.
   - Ne crée PAS 2 bulletins séparés pour le recto et verso d'un même document.

🔴 BÉNÉFICIAIRE (case cochée) :
14. Regarde les cases à cocher : □ Adhérent  □ Conjoint  □ Enfant
   - Une case cochée = ✓ ou ✗ ou remplie au stylo.
   - Si "Conjoint" est coché, le nom du malade est le CONJOINT (pas l'adhérent).
   - Si "Enfant" est coché, le nom du malade est l'ENFANT.
   - Si aucune case n'est clairement cochée, mettre "Adhérent" par défaut.

🔵 CODES CNAM ET LETTRES-CLÉS (pour auto-complétion côté plateforme) :
15. Pour chaque acte médical extrait, cherche à identifier la LETTRE-CLÉ CNAM si elle est visible sur le document :
   * KC = actes chirurgicaux (ex: KC50 pour une suture)
   * KE = actes d'explorations (endoscopie, biopsie)
   * K = actes techniques médicaux
   * Z = actes utilisant des radiations ionisantes
   * B = actes de biologie/analyses (ex: B10 pour groupe sanguin, B60 pour NFS)
   * Rd = actes de radiologie diagnostique
   * D = actes dentaires
   * P = actes d'anatomo-pathologie
   * SC, SF = actes de sages-femmes
   * AMO, AMI, AMS = actes infirmiers
   * TO, TM = actes de rééducation (kiné)
   - La cotation est le NOMBRE qui suit la lettre-clé (ex: dans "KC50", la lettre_cle est "KC" et la cotation est 50).
   - Sur les factures de laboratoire, la cotation est souvent visible (ex: "B40", "B60", "B127").
   - Sur les factures de radiologie, cherche le code Rd ou Z (ex: "Rd15", "Z30").
   - Sur les factures de chirurgie/clinique, cherche KC (ex: "KC50", "KC120").

🔵 DÉSIGNATIONS PRÉCISES :
16. NE JAMAIS utiliser des termes génériques comme "Acte Biologique", "Consommables", "Pharmacie Interne", "Forfait" quand la facture détaille les actes.
   - Lire CHAQUE LIGNE de la facture et extraire la désignation EXACTE telle qu'écrite (ex: "NUMÉRATION FORMULE SANGUINE", "GLYCÉMIE À JEUN", "ÉCHOGRAPHIE ABDOMINALE").
   - Si la facture est une facture globale d'hospitalisation/clinique avec des postes génériques (Consommables, Pharmacie Interne, Timbre Fiscal, Frais de séjour), extraire ces postes tels quels — ce sont des postes hospitaliers, pas des actes CNAM.
   - Pour les analyses biologiques : TOUJOURS détailler chaque analyse séparément dans details_lignes, avec sa cotation B si visible.
   - Pour la radiologie : TOUJOURS préciser le type exact (Échographie abdominale, Radio thorax face, Scanner cérébral...) plutôt que "Radiologie" ou "Imagerie".

🔵 REGROUPEMENT PHARMACIE RENFORCÉ :
17. UN acte PHARMACIE = UN ticket/facture d'UNE pharmacie à UNE date.
   - TOUTES les lignes du même ticket vont dans "details_lignes" avec pour chaque médicament : nom corrigé, code_amm si visible, quantité, prix unitaire, total ligne.
   - Le champ "montant" de l'acte = TOTAL du ticket.
   - Ne crée JAMAIS un acte PHARMACIE séparé par médicament.
   - VÉRIFICATION FINALE : Avant de retourner le JSON, vérifie qu'il n'y a pas 2 actes PHARMACIE avec la même pharmacie ET la même date. Si oui, fusionner leurs details_lignes dans UN SEUL acte et additionner les montants.

🔴 ACCORD PRÉALABLE (APB) :
18. Certains actes nécessitent un ACCORD PRÉALABLE de la CNAM avant d'être réalisés.
   - Indices de présence d'un accord préalable :
     * Document séparé intitulé "Accord préalable", "Décision de prise en charge", "Autorisation préalable", "APB"
     * Mention "Prise en charge" ou "Accord" dans le décompte CNAM (colonne décision)
     * Numéro de décision ou référence d'accord sur un document CNAM
     * Ligne "APB" dans un reçu ou facture de laboratoire (ex: ligne APB avec montant séparé sur un reçu labo)
   - Si un accord préalable est détecté pour un acte, mettre "accord_prealable": true dans cet acte.
   - Si aucun accord préalable n'est détecté → "accord_prealable": false.

IMPORTANT :
- Le bulletin de soins est le document PRINCIPAL (il a un numéro de bulletin imprimé).
- Les autres documents (reçus, ordonnances, analyses, décompte CNAM) sont des PIÈCES JUSTIFICATIVES qui complètent les actes du bulletin.
- Croise les informations entre les documents : si le bulletin a un acte "consultation" vide, mais qu'un reçu montre "Dr Driss, 50 DT, consultation", remplis l'acte avec ces infos.
- Un praticien apparaît souvent sur plusieurs documents (bulletin + ordonnance + reçu). Unifie les informations.
- Le décompte CNAM est une source FIABLE pour les montants remboursés. Utilise-le pour alimenter automatiquement les champs "montant_cnam".

Retourne UNIQUEMENT ce JSON :

        {
          "infos_adherent": {
            "assureur_detecte": "BH Assurance | CARTE Assurances | CNAM | STAR | GAT | autre (détecté via logo/en-tête)",
            "nom_prenom": "Nom de l'adhérent",
            "numero_adherent": "N° de l'adhérent (N° contrat/police)",
            "numero_cnam": "N° CNAM de l'adhérent (champ N° CNAM / Adhésion N° sur le bulletin)",
            "employeur": "Nom de l'employeur (champ Employeur sur le bulletin)",
            "numero_bulletin": "N° du bulletin (PRIORITÉ HAUTE — chercher manuscrit, tampon, champ N° BS)",
            "date_bulletin": "Date du bulletin (JJ/MM/AAAA)",
            "beneficiaire_coche": "Conjoint / Enfant / Adhérent (case cochée, défaut: Adhérent)"
          },
          "infos_patient": {
            "nom_prenom_malade": "Nom du patient soigné"
          },
          "actes_independants": [
            {
              "type": "MEDECIN",
              "date": "...",
              "praticien": "Nom du médecin traitant",
              "matricule_fiscale": "...",
              "acte": "Désignation EXACTE (ex: Consultation spécialisée cardiologie, Visite à domicile)",
              "lettre_cle": "KC ou K ou KE ou C ou V si visible",
              "cotation": "Nombre après la lettre-clé (ex: 50 pour KC50)",
              "montant": "...",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "RADIOLOGIE",
              "date": "...",
              "centre_radiologie": "Nom du centre ou médecin radiologue",
              "matricule_fiscale": "...",
              "medecin_prescripteur": "Médecin ayant prescrit la radio",
              "acte": "Désignation EXACTE (ex: Échographie abdominale, Radio thorax face, Scanner cérébral)",
              "lettre_cle": "Rd ou Z si visible",
              "cotation": "Nombre après la lettre-clé (ex: 15 pour Rd15)",
              "montant": "...",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "PHARMACIE",
              "date": "...",
              "pharmacie": "...",
              "matricule_fiscale": "...",
              "details_lignes": [
                {
                  "medicament": "Nom EXACT du médicament (corrigé depuis facture imprimée)",
                  "code_amm": "Code AMM si visible",
                  "quantite": "...",
                  "prix_unitaire": "...",
                  "total_ligne": "..."
                }
              ],
              "montant": "TOTAL du ticket/facture pharmacie",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
           {
              "type": "LABORATOIRE",
              "date": "Date de l'analyse",
              "laboratoire": "Nom complet du labo",
              "matricule_fiscale": "MF du laboratoire",
              "medecin_prescripteur": "Nom du médecin",
              "details_lignes": [
                {
                  "acte": "Désignation EXACTE (ex: NUMÉRATION FORMULE SANGUINE, GLYCÉMIE À JEUN)",
                  "code_acte": "Code CNAM si visible (ex: BCA000010)",
                  "lettre_cle": "B",
                  "cotation": "Nombre (ex: 60 pour B60)",
                  "montant": "Montant de cette ligne"
                }
              ],
              "montant": "Montant Total facturé pour cet acte labo",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "HOSPITALISATION",
              "clinique": "Nom de la clinique/hôpital",
              "matricule_fiscale": "MF de la clinique",
              "date_entree": "Date d'entrée (JJ/MM/AAAA)",
              "date_sortie": "Date de sortie (JJ/MM/AAAA)",
              "motif": "Motif d'hospitalisation (accouchement, chirurgie, etc.)",
              "details_lignes": [
                {
                  "prestation": "Désignation EXACTE (ex: CHAMBRE INDIVIDUELLE, RCF CONTINUE, ASSISTANCE SAGE-FEMME)",
                  "quantite": "Quantité",
                  "prix_unitaire": "Prix unitaire",
                  "tva": "Taux TVA si visible",
                  "montant": "Montant HT ou TTC"
                }
              ],
              "compte_autrui": [
                {
                  "nom_prestataire": "Nom du prestataire externe (médecin, anesthésiste, pharmacie, labo)",
                  "matricule_fiscale": "MF du prestataire",
                  "nature_acte": "Nature de l'acte (Consultation, ANESTHESISTE, ACCOUCHEMENT, etc.)",
                  "montant": "Montant TTC"
                }
              ],
              "total_clinique": "Total des frais clinique propres",
              "total_compte_autrui": "Total compte d'autrui",
              "montant": "Total général de la facture (clinique + compte d'autrui)",
              "lettre_cle": "KC si visible (ex: KC pour accouchement)",
              "cotation": "Nombre après la lettre-clé si visible",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "DENTAIRE",
              "date": "Date de l'acte",
              "praticien": "Nom du dentiste",
              "matricule_fiscale": "MF du dentiste",
              "type_soin_dentaire": "DC pour SOINS DENTAIRES (partie haute du formulaire), DP pour PROTHESE DENTAIRE (partie basse)",
              "dents": "Numéros des dents traitées (ex: 11, 21, 36)",
              "acte": "Désignation EXACTE (ex: Détartrage, Extraction, Prothèse dentaire)",
              "lettre_cle": "D",
              "cotation": "Nombre après la lettre-clé (ex: 40 pour D40)",
              "montant": "Honoraires",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "OPTIQUE",
              "date": "Date de l'acte",
              "praticien": "Nom de l'opticien/lunettier",
              "matricule_fiscale": "MF de l'opticien",
              "acte": "Monture + Verres optiques",
              "details_lignes": [
                {
                  "designation": "Désignation EXACTE (ex: Monture optique, Verres progressifs, Traitement anti-reflet)",
                  "quantite": "Quantité",
                  "montant": "Montant"
                }
              ],
              "prescription_optique": {
                "oeil_droit": "Correction OD (ex: +0.25 (-0.25 à 5°))",
                "oeil_gauche": "Correction OG (ex: 0.00 (-0.50 à 175°))"
              },
              "montant": "Total TTC de la facture",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            },
            {
              "type": "PARAMEDICAL",
              "date": "Date de l'acte",
              "praticien": "Nom du praticien paramédical (kiné, sage-femme, infirmier)",
              "matricule_fiscale": "MF du praticien",
              "acte": "Désignation EXACTE (ex: Séance de rééducation, Soins infirmiers)",
              "lettre_cle": "SC ou SF ou AMO ou AMI ou AMS ou TO ou TM si visible",
              "cotation": "Nombre après la lettre-clé",
              "montant": "Honoraires",
              "montant_cnam": "Montant remboursé CNAM pour cet acte (si décompte CNAM présent)",
              "accord_prealable": false
            }
          ],
          "cnam": {
            "numero_assure": "N° de l'assuré CNAM",
            "caisse": "Nom de la caisse (ex: CNSS, CNRPS...)",
            "beneficiaire": "Bénéficiaire (ex: Conjoint - SAMIA, Adhérent...)",
            "regime": "Régime (ex: APCI/MLD, AMG...)",
            "ref_paiement": "Référence de paiement / Mandat",
            "date_decompte": "Date du décompte (JJ/MM/AAAA)",
            "details_remboursement": [
              {
                "categorie": "Consultation & Visites | Actes | Médicaments | autre section",
                "lignes": [
                  {
                    "code": "Code du produit/acte (si disponible)",
                    "designation": "Désignation de l'acte ou du médicament",
                    "quantite": "Quantité (si disponible)",
                    "date": "Date de l'acte",
                    "montant_depense": "Montant dépensé",
                    "montant_rembourse": "Montant remboursé par la CNAM",
                    "decision": "Décision médicale (Accord, Rejet, etc.)"
                  }
                ]
              }
            ],
            "total_depense": "Total dépensé (toutes sections)",
            "total_rembourse": "Total remboursé par la CNAM (toutes sections)"
          },
          "pieces_justificatives": [
            {
              "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | LETTRE_CONFIDENTIELLE | AUTRE",
              "rattachement_acte": 0,
              "praticien": "Nom du médecin/prescripteur",
              "date": "Date du document (JJ/MM/AAAA)",
              "contenu": {
                "medicaments_prescrits": [
                  {
                    "nom": "Nom du médicament",
                    "posologie": "Posologie prescrite",
                    "duree": "Durée du traitement",
                    "quantite": "Quantité prescrite"
                  }
                ],
                "resultats_bilan": [
                  {
                    "parametre": "Nom du paramètre (ex: Glycémie, Cholestérol...)",
                    "valeur": "Valeur mesurée",
                    "unite": "Unité (g/l, mmol/l...)",
                    "norme": "Valeurs normales de référence"
                  }
                ],
                "texte_libre": "Contenu textuel pour COMPTE_RENDU ou AUTRE (résumé fidèle)",
                "lettre_confidentielle": {
                  "clinique": "Nom de la clinique",
                  "chirurgien": "Nom du chirurgien",
                  "date_hospitalisation": "Date d'hospitalisation (JJ/MM/AAAA)",
                  "date_operation": "Date d'opération (JJ/MM/AAAA)",
                  "motif": "Motif (accouchement, chirurgie, etc.)",
                  "codification_cnam": "Codification CNAM complète (ex: Kc P1)",
                  "lettre_cle": "Lettre-clé extraite (ex: KC)",
                  "cotation": "Cotation extraite (ex: P1)"
                }
              },
              "montant": "Montant figurant sur la pièce (si applicable)",
              "observations": "Remarques : écarts ordonnance/pharmacie, anomalies détectées"
            }
          ],
          "synthese": {
            "total_medecin": "Somme Consultations ou 0",
            "total_radiologie": "Somme Actes Radio/Imagerie ou 0",
            "total_pharmacie": "Somme pharmacie ou 0",
            "total_laboratoire": "Total labo ou 0",
            "total_hospitalisation": "Total hospitalisation/clinique ou 0",
            "total_dentaire": "Total actes dentaires ou 0",
            "total_optique": "Total actes optique ou 0",
            "total_paramedical": "Total actes paramédicaux ou 0",
            "total_global_calcule": "La somme de tout le dossier",
            "total_cnam": "Total remboursé par la CNAM (depuis le décompte CNAM si présent, sinon 0)",
            "devise": "DT"
          }
        }

RÈGLES :
- "beneficiaire_coche" : lis la case cochée (✓, ✗, remplie au stylo) → "Adhérent", "Conjoint" ou "Enfant". Si aucune case clairement cochée → "Adhérent" par défaut.
- "conjoint.nom_prenom" : remplis UNIQUEMENT si case "Conjoint" cochée.
- "enfants" : remplis UNIQUEMENT si case "Enfant" cochée. Sinon tableau vide [].
- Chaque acte = un soin distinct. Si le bulletin montre une ligne "consultation" et qu'une ordonnance du même médecin existe → c'est le MÊME acte, mets l'ordonnance DANS cet acte.
- "ordonnance", "pharmacie", "analyse" : remplis ces sous-objets UNIQUEMENT si un document correspondant existe dans les images. Si pas de document → ne mets pas la clé.
- "cnam" : remplis ce bloc UNIQUEMENT si un document CNAM (décompte de remboursement) est présent dans les images. Si aucun document CNAM → ne mets pas la clé "cnam".
- "pieces_justificatives" : remplis ce tableau UNIQUEMENT si des documents justificatifs (ordonnances, bilans, reçus, factures, comptes-rendus, lettres confidentielles) sont présents dans les images. Si aucun → tableau vide []. Dans "contenu", remplis UNIQUEMENT les sous-clés pertinentes au type de pièce : "medicaments_prescrits" pour ORDONNANCE, "resultats_bilan" pour BILAN, "lettre_confidentielle" pour LETTRE_CONFIDENTIELLE, "texte_libre" pour COMPTE_RENDU/AUTRE. Supprime les sous-clés non pertinentes.
- "assureur_detecte" : identifie l'assureur via le logo, l'en-tête, la mise en page. Si non identifiable → "".
- "numero_cnam" : cherche le champ "N° CNAM" ou "Adhésion N°" sur le bulletin. Distinct du "numero_adherent". Si non visible → "".
- "employeur" : cherche le champ "Employeur" sur le bulletin. Si non visible → "".
- "lettre_cle" et "cotation" : remplis sur TOUS les types d'actes (MEDECIN, RADIOLOGIE, LABORATOIRE, HOSPITALISATION, DENTAIRE, PARAMEDICAL) si la lettre-clé CNAM est visible sur le document (facture, reçu, bulletin, lettre confidentielle). Si non visible → "". Ne jamais inventer de cotation.
- Pour HOSPITALISATION : "compte_autrui" est un tableau SÉPARÉ de "details_lignes". Les prestataires externes (médecins, anesthésiste, pharmacie, labo) vont dans "compte_autrui". Les prestations propres à la clinique (chambre, sage-femme, pharmacie interne) vont dans "details_lignes".
- Pour DENTAIRE : le formulaire dentaire tunisien a 2 sections — "SOINS DENTAIRES" (soins conservateurs = DC) et "PROTHESE DENTAIRE" (prothèses = DP). Remplir "type_soin_dentaire" avec "DC" ou "DP" selon la section. Cette distinction est critique pour le calcul des plafonds. Extrais les numéros de dents du diagramme dentaire si visible. Lettre-clé = D.
- Pour OPTIQUE : quand le prestataire est un opticien/lunettier ou que la facture contient montures/verres, utiliser type "OPTIQUE" (JAMAIS "PARAMEDICAL"). Séparer chaque ligne de la facture (monture, verres, traitements) dans "details_lignes". Si une ordonnance ophtalmologique est présente avec des corrections OD/OG, remplir "prescription_optique".
- Pour PARAMEDICAL : lettre-clé = SC/SF pour sages-femmes, AMO/AMI/AMS pour infirmiers, TO/TM pour kiné.
- NE JAMAIS inventer de données. Si pas visible → "".
- Les noms sont tunisiens. "nekk" → "Mekki", "nohaned" → "Mohamed".
- "matricule_fiscale" : format tunisien 7 chiffres + lettre + 3 caractères. NE JAMAIS inventer.

ÉTAPE 1 : Identifie chaque image (bulletin, ordonnance, reçu, bilan, facture, compte-rendu, décompte CNAM...).
ÉTAPE 2 : Extrais l'adhérent depuis le bulletin.
ÉTAPE 3 : Pour chaque acte du bulletin, cherche dans les AUTRES images les documents qui correspondent (même médecin, même date, même patient) et intègre-les dans l'acte.
ÉTAPE 4 : Si un décompte CNAM est présent, extrais ses données dans le bloc "cnam" et croise les montants remboursés avec les actes correspondants (montant_cnam).
ÉTAPE 5 : Pour chaque pièce justificative (ordonnance, bilan, reçu, facture, compte-rendu), extrais ses données dans "pieces_justificatives" et rattache-la à l'acte correspondant. Vérifie la cohérence ordonnance/pharmacie.
Si des champs sont introuvables (même après croisement), indique "". N'ajoute pas de balises de code Markdown.`;

// ─────────────────────────────────────────────
// PROMPT CLASSIQUE / SIMPLE
// Utilisé pour la route POST /ocr (un fichier)
// ─────────────────────────────────────────────
const OCR_PROMPT = `Tu es une IA spécialisée dans le traitement OCR de documents de santé Tunisiens.
Analyse ce document (peut être une ordonnance, note labo, etc.). 
Extrais un maximum d'informations et réponds sous le format de l'API demandée (structuration classique et générique).
Privilégie les cachets. Fais attention à la typographie tunisienne.
Réponds exclusivement en JSON structuré (infos_assurance, details, dates, etc.), selon ton propre format lisible sans balises.`;

// ─────────────────────────────────────────────
// Helpers Techniques
// ─────────────────────────────────────────────
async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 🟢 gemini-1.5-pro est LE modèle optimisé de vision (à défaut, 1.5-flash est rapide)
const GEMINI_MODELS = [
  "gemini-3.1-pro-preview"
  // "gemini-3.1-flash-lite-preview",
];

async function generateWithFallback(env, parts) {
   const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  let lastError;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
      });
      // Mode Température ZERO : Crucial pour les actes mathématiques, matrices & extractions strictes.
      const generationConfig = {
        responseMimeType: "application/json",
        temperature: 0.0,
      };

      const result = await model.generateContent({
        contents: [{ role: "user", parts }],
        generationConfig,
      });
      result.modelUsed = modelName;
      return result;
    } catch (err) {
      lastError = err;
      const status = err.message || "";
      if (
        status.includes("503") ||
        status.includes("429") ||
        status.includes("500") ||
        status.includes("not found")
      ) {
        console.log(
          `Modèle ${modelName} indisponible ou non-existant, tentative du suivant...`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────
// Routes Publiques & Swagger (docs)
// ─────────────────────────────────────────────
app.get("/", (c) => {
  return c.json({
    message: "API OCR BH Assurance (Intelligente)",
    version: "3.0.0", // version upgradée grâce aux auto-corrections !
    endpoints: [
      "POST /analyse-bulletin (MULTI-DOC, Structure complète IA avec correction automatique)",
      "POST /ocr (SIMPLIFIÉ pour 1 seul fichier manuel)",
      "POST /valider",
      "GET  /bulletins",
      "GET  /bulletins/:id",
      "GET  /admin  (tableau de bord)",
      "GET  /docs   (Swagger UI)",
    ],
  });
});

app.get("/openapi.json", (c) => {
  return c.json({
    openapi: "3.0.3",
    info: {
      title: "API OCR BH Assurance (Intelligente)",
      description:
        "API d'extraction OCR de dossiers médicaux avec auto-correction croisée et séparation médecins/radiologie via Gemini AI 1.5.",
      version: "3.0.0",
    },
    paths: {
      "/": {
        get: {
          summary: "Statut de l'API",
          responses: { 200: { description: "API active" } },
        },
      },
      "/analyse-bulletin": {
        post: {
          summary:
            "Analyser un Dossier de soins Complet (IA Avancée Multi-docs)",
          description:
            "Envoie plusieurs images (bulletin, tickets de caisse, labo) pour extraction OCR et croisement d'auto-correction automatique.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    files: {
                      type: "array",
                      items: { type: "string", format: "binary" },
                      description:
                        "Images (Bulletin, Ordonnance, Facture, Pharmacie, Labo) au format JPEG/PNG",
                    },
                  },
                  required: ["files"],
                },
              },
            },
          },
          responses: {
            200: {
              description:
                "Données croisées, catégorisées et corrigées extraites par l'IA",
            },
            422: { description: "Aucun fichier envoyé" },
            500: { description: "Erreur serveur / Erreur OCR" },
          },
        },
      },
      "/ocr": {
        post: {
          summary: "OCR Simple Manuel",
          description:
            "Envoie 1 SEULE image et retourne l'information générique de celle-ci.",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: {
                      type: "string",
                      format: "binary",
                      description: "Fichier Unique (JPEG/PNG)",
                    },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: { 200: { description: "JSON brut de la photo unique" } },
        },
      },
      "/valider": {
        post: {
          summary: "Valider ou Corriger en D1 Database",
          description:
            "Permet de renvoyer le JSON corrigé par le superviseur humain.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    donnees_ia: { type: "object" },
                    metadata_validation: {
                      type: "object",
                      properties: {
                        statut_validation: {
                          type: "string",
                          example: "valide",
                        },
                        erreurs_signalees: {
                          type: "array",
                          items: { type: "string" },
                        },
                        commentaires_correction: { type: "string" },
                      },
                      required: ["statut_validation"],
                    },
                  },
                  required: ["donnees_ia", "metadata_validation"],
                },
              },
            },
          },
          responses: { 200: { description: "Feedback OK" } },
        },
      },
      "/bulletins": {
        get: {
          summary: "Historique Base D1",
          responses: {
            200: { description: "100 derniers bulletins Validés / Rejetés" },
          },
        },
      },
      "/bulletins/{id}": {
        get: {
          summary: "Détails Validation N°ID",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: { 200: { description: "Details du record SQLite (D1)" } },
        },
      },
    },
  });
});

app.get("/docs", (c) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>API OCR BH Assurance - Swagger</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>`;
  return c.html(html);
});

// ─────────────────────────────────────────────
// ROUTE PRINCIPALE DU SYSTÈME -> POST /analyse-bulletin (Smart Extract Multi Docs)
// ─────────────────────────────────────────────
app.post("/analyse-bulletin", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files");

    if (!files || files.length === 0) {
      return c.json(
        {
          error:
            "Aucun fichier envoyé. Mettez le Bulletin + Pièces Justificatives (Ordos, Pharmacies) dans 'files'",
        },
        422,
      );
    }

    const imageParts = await Promise.all(
      files.map(async (file) => {
        const base64 = await fileToBase64(file);
        return {
          inlineData: { data: base64, mimeType: file.type || "image/jpeg" },
        };
      }),
    );

    // Choisir le prompt : simple pour 1 fichier, unifié multi-docs pour plusieurs
    const prompt = files.length === 1 ? PROMPT : PROMPT_DOSSIER;
    const promptPart = { text: prompt };
    const partsToGemini = [promptPart, ...imageParts];

    const result = await generateWithFallback(c.env, partsToGemini);
    const text = result.response.text();

    let data = null;
    let parseOk = false;
    try {
      const cleaned = text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      data = JSON.parse(cleaned);
      parseOk = true;
    } catch {
      /* ignoré - data vaquera au catch conditionnel */
    }

    // Logs (D1 Tracker)
    if (c.env.DB) {
      await logUsageEvent(c.env.DB, {
        endpoint: "/analyse-bulletin",
        provider: "gemini",
        status: "success",
        nb_fichiers: files.length,
        duree_ms: Date.now() - startTime,
      }).catch(() => {});
    }

    return c.json({
      success: true,
      nombre_fichiers: files.length,
      resultat: data,
      ...(parseOk
        ? {}
        : {
            reponse_brute: text,
            avertissement: "Réponse in-parsable côté JS (Gemini a mal formulé)",
          }),
    });
  } catch (err) {
    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/analyse-bulletin",
        provider: "gemini",
        status: "error",
        nb_fichiers: 0,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /ocr - (La Version compatible ancien format, Un Seul Doc Brute)
// N.B: Dans votre code il y avait 2 fois POST /ocr !
// Ils ont été fusionnés en un seul block optimal ci-dessous :
// ─────────────────────────────────────────────
app.post("/ocr", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file) {
      return c.json({ error: "Aucun fichier (file) envoyé." }, 422);
    }

    const base64 = await fileToBase64(file);
    const promptPart = { text: OCR_PROMPT };
    const imagePart = {
      inlineData: { data: base64, mimeType: file.type || "image/jpeg" },
    };

    const result = await generateWithFallback(c.env, [promptPart, imagePart]);
    const text = result.response.text();

    let data = null;
    let parseOk = false;
    try {
      const cleaned = text
        .replace(/```json\n?/gi, "")
        .replace(/```\n?/g, "")
        .trim();
      data = JSON.parse(cleaned);
      parseOk = true;
    } catch {
      /* Fallback prévu */
    }

    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "success",
        nb_fichiers: 1,
        duree_ms: Date.now() - startTime,
      }).catch(() => {});

    if (parseOk) {
      return c.json({ success: true, resultat: data });
    } else {
      return c.json({
        success: true,
        resultat: null,
        reponse_brute: text,
        avertissement: "JSON imparfait",
      });
    }
  } catch (err) {
    if (c.env.DB)
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "error",
        nb_fichiers: 1,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    return c.json(
      { success: false, erreur: err.message || "Erreur interne OCR" },
      500,
    );
  }
});

// ─────────────────────────────────────────────
// Boucle FEEDBACK VALIDATION D1 (/valider) et FETCH DE TABLES
// ─────────────────────────────────────────────
app.post("/valider", async (c) => {
  try {
    const body = await c.req.json();
    const { donnees_ia, metadata_validation } = body;
    if (!donnees_ia || !metadata_validation)
      return c.json({ success: false, erreur: "JSON attendu mal formé" }, 422);
    const { statut_validation, erreurs_signalees, commentaires_correction } =
      metadata_validation;

    if (!statut_validation)
      return c.json(
        { success: false, erreur: "'statut_validation' est requis" },
        422,
      );

    const result = await c.env.DB.prepare(
      `INSERT INTO bulletins_valides (donnees_ia, statut_validation, erreurs_signalees, commentaires_correction) VALUES (?, ?, ?, ?)`,
    )
      .bind(
        JSON.stringify(donnees_ia),
        statut_validation,
        JSON.stringify(erreurs_signalees || []),
        commentaires_correction || "",
      )
      .run();

    return c.json({
      success: true,
      message: "Feedback ok",
      id: result.meta.last_row_id,
      statut: statut_validation,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

app.get("/bulletins", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM bulletins_valides ORDER BY created_at DESC LIMIT 100",
    ).all();
    return c.json({ success: true, total: results.length, bulletins: results });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

app.get("/bulletins/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const bulletin = await c.env.DB.prepare(
      "SELECT * FROM bulletins_valides WHERE id = ?",
    )
      .bind(id)
      .first();
    if (!bulletin) return c.json({ success: false, erreur: "Inexistant" }, 404);

    return c.json({
      success: true,
      bulletin: {
        ...bulletin,
        donnees_ia: JSON.parse(bulletin.donnees_ia || "{}"),
        erreurs_signalees: JSON.parse(bulletin.erreurs_signalees || "[]"),
      },
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// Route expérimentale de batch array-files : Demandée conservée intact.
app.post("/upload", async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const files = body["images"];
    if (!files) return c.json({ error: "Aucun fichier 'images' posté" }, 400);

    const fileArray = Array.isArray(files) ? files : [files];
    const results = [];

    for (const file of fileArray) {
      if (file instanceof File) {
        // Validation basique de concept (ne lance pas genAi explicitement comme posté ds l'exemple originel)
        results.push({ filename: file.name, status: "processed" });
      }
    }
    return c.json({
      message: "Upload de simulation /test ok",
      count: results.length,
      details: results,
    });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
