// src/index.js
// API OCR BH Assurance — Cloudflare Workers + Hono
// Inclut la plateforme d'administration (point 3)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "./admin.js";
import { logUsageEvent } from "./stats.js";

const TYPES_SOINS_TUNISIE = [
  "consultation",
  "analyse biologique",
  "radiologie",
  "pharmacie",
  "chirurgie",
  "soins dentaires",
  "hospitalisation",
  "optique",
  "kinésithérapie",
  "maternité",
  "prothèse",
  "orthopédie",
  "autre",
];

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
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_logs_status ON usage_logs(status)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_logs_endpoint ON usage_logs(endpoint)`),
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

// ─────────────────────────────────────────────
// Monter la plateforme d'administration
// Route : /admin/**
// ─────────────────────────────────────────────
app.route("/admin", admin);

// ─────────────────────────────────────────────
// Prompts OCR
// ─────────────────────────────────────────────
const PROMPT = `Analyse ces images d'un bulletin de soins BH Assurance.
Extrais avec précision TOUTES les informations visibles.

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
  "adherent": {
    "nom_prenom": "",
    "numero_contrat": "",
    "numero_adherent": "",
    "numero_bulletin": "",
    "adresse": "",
    "date_signature": "",
    "beneficiaire": "adherent",
    "conjoint": {
      "nom_prenom": ""
    },
    "enfants": [
      {
        "nom_prenom": ""
      }
    ]
  },
  "actes": [
    {
      "type_soin": "",
      "nature_acte": "",
      "date_acte": "",
      "praticien": {
        "nom_prenom": "",
        "specialite": "",
        "matricule_fiscale": ""
      },
      "montant_honoraires": "",
      "montant_facture": ""
    }
  ]
}

RÈGLE ABSOLUE - NE JAMAIS INVENTER :
- Tu ne dois JAMAIS inventer, deviner ou halluciner une donnée.
- Si un champ n'est PAS visible sur le document, mets une chaîne vide "".
- Si un champ est visible mais illisible, mets "illisible".
- Mieux vaut retourner "" que d'inventer une valeur fausse.

ÉTAPE 1 - LECTURE PIXEL PAR PIXEL :
Examine attentivement chaque zone du document. Lis lettre par lettre, chiffre par chiffre.

ÉTAPE 2 - EXTRACTION DES CHAMPS :

SECTION ADHÉRENT :
- "nom_prenom" : nom et prénom de l'adhérent principal. C'est un document TUNISIEN, noms arabes/tunisiens.
  RÈGLES pour les noms manuscrits :
  1. ATTENTION lettres similaires : 'm'/'n', 'l'/'i', 'u'/'v', 'rn'/'m', 'k'/'h'.
  2. Majuscules → convertir en "Nom Prenom".
  3. Corrige vers un nom tunisien connu si ambigu. Noms courants : Mekki, Meddeb, Ben Ali, Bouazizi, Trabelsi, Gharbi, Jebali, Hammami, Mansouri, Chaabane, Karoui, Sassi, Haddad, Mejri, Dridi, Khemiri, Abidi, Jaziri, Amri, Brahmi, Belhadj, Rezgui, Laabidi, Ferchichi, Bouzid, Ayari, Mbarki, Nefzi, Riahi, Saidi, Khalfi.
  Prénoms courants : Mohamed, Ahmed, Ali, Fatma, Imen, Dhekra, Amira, Sana, Hela, Rania, Yassine, Sirine, Nour, Hichem, Amine, Karim, Sami, Nabil, Riadh, Mourad, Walid, Slim, Hatem, Ons, Mariem, Asma, Emna, Rim, Ines, Olfa.
  4. "nekk" → probablement "Mekki". "nohaned" → probablement "Mohamed".

- "numero_contrat" : souvent IMPRIMÉ/TAMPONNÉ. Cherche près de "N° Contrat", "Police N°". Attention : 0/O, 1/I/l, 5/S, 8/B.
- "numero_adherent" : numéro d'adhérent, souvent en haut du document.
- "numero_bulletin" : numéro imprimé sur le bulletin.

SECTION BÉNÉFICIAIRE :
- "beneficiaire" : qui est le malade ? Lis la case cochée sur le bulletin :
  - Si "Adhérent" coché ou aucune case → "adherent"
  - Si "Conjoint" coché → "conjoint"
  - Si "Enfant" coché → "enfant"
- "conjoint.nom_prenom" : UNIQUEMENT si la case "Conjoint" est cochée, lis le nom du malade dans la section praticien "Nom et Prénom du malade". Si pas coché ou pas visible, mets "".
- "enfants" : UNIQUEMENT si la case "Enfant" est cochée, lis le nom de l'enfant malade. Si pas coché ou pas visible, mets un tableau vide [].

SECTION ACTES :
- Chaque ligne du volet médical = un acte séparé dans le tableau "actes".
- "type_soin" : ${TYPES_SOINS_TUNISIE.join(", ")}. Si "médecin"/"docteur" sans précision → "consultation". Labo → "analyse biologique". Clinique avec séjour → "hospitalisation".
- "nature_acte" : description détaillée (ex: "consultation cardiologie", "analyse sang NFS", "radio thorax").
- "praticien.nom_prenom" : cherche dans le TAMPON/CACHET (plus fiable que manuscrit). Format "Dr NOM Prénom" + spécialité.
- "praticien.specialite" : la spécialité du médecin si visible dans le tampon.
- "praticien.matricule_fiscale" : NE JAMAIS INVENTER. Format tunisien : 7 chiffres + lettre + 3 caractères (ex: "1234567A/P/M/000"). Si pas visible clairement, mets "".
- "montant_honoraires" : attention aux chiffres manuscrits (0/6, 1/7, 5/8). Format avec virgule/point décimal.
- "montant_facture" : montant facturé si différent des honoraires.

RÈGLES FINALES :
- Champ VIDE sur le document → ""
- Champ REMPLI mais illisible → "illisible"
- Ne confonds pas vide et illisible.`;

const OCR_PROMPT = `Analyse cette image d'un bulletin de soins BH Assurance.
Extrais avec précision TOUTES les informations visibles sur le document.

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
  "infos_adherent": {
    "nom_prenom": "",
    "numero_contrat": "",
    "numero_bulletin": "",
    "numero_matricule": "",
    "date_naissance": "",
    "adresse": "",
    "telephone": "",
    "email": "",
    "employeur": "",
    "lien_beneficiaire": "",
    "beneficiaire_coche": "",
    "date_signature": ""
  },
  "infos_assurance": {
    "nom_assurance": "",
    "numero_police": "",
    "categorie": "",
    "date_effet": "",
    "date_expiration": "",
    "taux_couverture": ""
  },
  "volet_medical": [
    {
      "date_acte": "",
      "nature_acte": "",
      "description_acte": "",
      "code_acte": "",
      "montant_honoraires": "",
      "montant_facture": "",
      "montant_rembourse": "",
      "reste_a_charge": "",
      "nom_praticien": "",
      "specialite_praticien": "",
      "matricule_fiscale": "",
      "nom_etablissement": "",
      "adresse_etablissement": "",
      "numero_facture": "",
      "date_facture": ""
    }
  ],
  "pharmacie": [
    {
      "nom_medicament": "",
      "quantite": "",
      "prix_unitaire": "",
      "montant_total": "",
      "nom_pharmacie": "",
      "date_achat": "",
      "numero_facture": ""
    }
  ],
  "totaux": {
    "total_honoraires": "",
    "total_factures": "",
    "total_rembourse": "",
    "total_reste_a_charge": ""
  },
  "observations": ""
}

IMPORTANT :
- "numero_bulletin" : le numéro imprimé sur le bulletin de soins.
- "nature_acte" : la nature de l'acte médical (ex: consultation, analyse biologique, radiologie, pharmacie, chirurgie, soins dentaires, hospitalisation, optique, etc.).
- "matricule_fiscale" : la matricule fiscale du praticien, souvent un code alphanumérique.
- "pharmacie" : si des médicaments sont listés séparément, les mettre dans cette section.
- "totaux" : les montants totaux si visibles en bas du document.
- "observations" : toute remarque ou note manuscrite visible sur le document.
- Si une section n'existe pas dans le document, retourne un tableau vide [] ou un objet vide {}.
- Si une valeur n'est pas lisible, mets "illisible". Ne laisse jamais un champ vide.`;

// ─────────────────────────────────────────────
// Helpers
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

// Modèles Gemini par ordre de préférence
const GEMINI_MODELS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-2.0-flash",
  "gemini-2.5-flash",
];

// Helper: générer du contenu avec fallback automatique entre modèles
async function generateWithFallback(env, parts) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  let lastError;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      });
      const result = await model.generateContent(parts);
      result.modelUsed = modelName;
      return result;
    } catch (err) {
      lastError = err;
      const status = err.message || "";
      if (status.includes("503") || status.includes("429") || status.includes("500")) {
        console.log(`Modèle ${modelName} indisponible, tentative suivante...`);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────
// Routes publiques
// ─────────────────────────────────────────────
app.get("/", (c) => {
  return c.json({
    message: "API OCR BH Assurance active",
    version: "2.0.0",
    endpoints: [
      "POST /analyse-bulletin  (bulletin + reçus + analyses + ordonnances...)",
      "POST /ocr",
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
      title: "API OCR BH Assurance",
      description: "API d'extraction OCR de bulletins de soins BH Assurance via Gemini AI",
      version: "2.0.0",
    },
    paths: {
      "/": {
        get: {
          summary: "Status de l'API",
          responses: {
            200: { description: "API active" },
          },
        },
      },
      "/analyse-bulletin": {
        post: {
          summary: "Analyser un dossier médical complet",
          description: "Envoie une ou plusieurs images (bulletin de soin, reçus, analyses, ordonnances, factures). Chaque fichier est automatiquement classifié puis extrait avec un prompt adapté à son type.",
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
                      description: "Images des documents médicaux (JPEG, PNG) — bulletin, reçu, analyse, ordonnance, facture, etc.",
                    },
                  },
                  required: ["files"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Dossier médical structuré",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      nombre_fichiers: { type: "integer" },
                      resultat: {
                        type: "object",
                        description: "Dossier unifié : adherent + actes (avec ordonnance, pharmacie, analyse intégrés dans chaque acte)",
                      },
                    },
                  },
                },
              },
            },
            422: { description: "Aucun fichier envoyé" },
          },
        },
      },
      "/ocr": {
        post: {
          summary: "OCR simple",
          description: "Envoie une image et retourne le JSON extrait",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            200: { description: "Données extraites" },
            422: { description: "Aucun fichier envoyé" },
          },
        },
      },
      "/valider": {
        post: {
          summary: "Valider/corriger un bulletin extrait",
          description: "Reçoit les données corrigées par l'utilisateur avec metadata de validation (boucle de feedback)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    donnees_ia: { type: "object", description: "Les données extraites, éventuellement corrigées par l'utilisateur" },
                    metadata_validation: {
                      type: "object",
                      properties: {
                        statut_validation: { type: "string", description: "Statut: en_attente, valide, corrige, rejete" },
                        erreurs_signalees: { type: "array", items: { type: "string" }, description: "Liste des erreurs signalées" },
                        commentaires_correction: { type: "string", description: "Commentaires de correction" },
                      },
                      required: ["statut_validation"],
                    },
                  },
                  required: ["donnees_ia", "metadata_validation"],
                },
              },
            },
          },
          responses: {
            200: { description: "Feedback enregistré", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, message: { type: "string" }, statut: { type: "string" } } } } } },
            422: { description: "Données manquantes", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, erreur: { type: "string" } } } } } },
          },
        },
      },
      "/bulletins": {
        get: {
          summary: "Lister les bulletins validés",
          description: "Retourne tous les bulletins validés/corrigés stockés en base",
          responses: {
            200: { description: "Liste des bulletins", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, total: { type: "integer" }, bulletins: { type: "array", items: { type: "object" } } } } } } },
          },
        },
      },
      "/bulletins/{id}": {
        get: {
          summary: "Récupérer un bulletin par ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            200: { description: "Bulletin trouvé" },
            404: { description: "Bulletin non trouvé", content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean" }, erreur: { type: "string" } } } } } },
          },
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
// Prompt unifié multi-documents
// Envoie toutes les images ensemble → Gemini produit un dossier propre
// ─────────────────────────────────────────────
const PROMPT_DOSSIER = `Tu reçois plusieurs images qui font partie du MÊME dossier médical d'un adhérent BH Assurance en Tunisie.
Ces images peuvent inclure : un bulletin de soins, des reçus, des ordonnances, des résultats d'analyse, des factures, etc.

Tu dois COMBINER toutes ces images pour produire UN SEUL dossier structuré et complet.

IMPORTANT :
- Le bulletin de soins est le document PRINCIPAL (il a un numéro de bulletin imprimé).
- Les autres documents (reçus, ordonnances, analyses) sont des PIÈCES JUSTIFICATIVES qui complètent les actes du bulletin.
- Croise les informations entre les documents : si le bulletin a un acte "consultation" vide, mais qu'un reçu montre "Dr Driss, 50 DT, consultation", remplis l'acte avec ces infos.
- Un praticien apparaît souvent sur plusieurs documents (bulletin + ordonnance + reçu). Unifie les informations.

Retourne UNIQUEMENT ce JSON :

{
  "adherent": {
    "nom_prenom": "",
    "numero_contrat": "",
    "numero_adherent": "",
    "numero_bulletin": "",
    "adresse": "",
    "beneficiaire": "adherent",
    "conjoint": { "nom_prenom": "" },
    "enfants": [{ "nom_prenom": "" }]
  },
  "actes": [
    {
      "type_soin": "",
      "nature_acte": "",
      "date_acte": "",
      "praticien": {
        "nom_prenom": "",
        "specialite": "",
        "matricule_fiscale": ""
      },
      "montant_honoraires": "",
      "montant_facture": "",
      "ordonnance": {
        "medicaments": [
          {
            "nom": "",
            "dosage": "",
            "posologie": "",
            "duree": ""
          }
        ]
      },
      "pharmacie": {
        "nom_pharmacie": "",
        "date_achat": "",
        "medicaments": [
          {
            "nom": "",
            "quantite": "",
            "prix": ""
          }
        ],
        "total": ""
      },
      "analyse": {
        "nom_laboratoire": "",
        "date": "",
        "resultats": [
          {
            "nom": "",
            "resultat": "",
            "valeurs_normales": ""
          }
        ]
      }
    }
  ],
  "total_dossier": {
    "total_honoraires": "",
    "total_pharmacie": "",
    "total_general": ""
  }
}

RÈGLES :
- "beneficiaire" : lis la case cochée → "adherent", "conjoint" ou "enfant".
- "conjoint.nom_prenom" : remplis UNIQUEMENT si case "Conjoint" cochée. Le nom du malade se trouve dans la section praticien du bulletin OU sur les ordonnances/reçus.
- "enfants" : remplis UNIQUEMENT si case "Enfant" cochée. Sinon tableau vide [].
- Chaque acte = un soin distinct. Si le bulletin montre une ligne "consultation" et qu'une ordonnance du même médecin existe → c'est le MÊME acte, mets l'ordonnance DANS cet acte.
- "ordonnance", "pharmacie", "analyse" : remplis ces sous-objets UNIQUEMENT si un document correspondant existe dans les images. Si pas de document → ne mets pas la clé.
- NE JAMAIS inventer de données. Si pas visible → "".
- NE JAMAIS mettre "illisible" partout. Si un champ n'est vraiment pas lisible, mets "". Réserve "illisible" UNIQUEMENT pour les champs où tu vois du texte mais ne peux pas le déchiffrer.
- Les noms sont tunisiens. Mêmes règles de correction : "nekk" → "Mekki", "nohaned" → "Mohamed".
- "matricule_fiscale" : format tunisien 7 chiffres + lettre + 3 caractères. NE JAMAIS inventer.
- "type_soin" : ${TYPES_SOINS_TUNISIE.join(", ")}.

ÉTAPE 1 : Identifie chaque image (bulletin, ordonnance, reçu, analyse...).
ÉTAPE 2 : Extrais l'adhérent depuis le bulletin.
ÉTAPE 3 : Pour chaque acte du bulletin, cherche dans les AUTRES images les documents qui correspondent (même médecin, même date, même patient) et intègre-les dans l'acte.`;

// ─────────────────────────────────────────────
// POST /analyse-bulletin
// 1 fichier  → prompt bulletin simple
// N fichiers → prompt unifié qui croise toutes les images
// ─────────────────────────────────────────────
app.post("/analyse-bulletin", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files");

    if (!files || files.length === 0) {
      return c.json({ error: "Aucun fichier envoyé" }, 422);
    }

    // Convertir tous les fichiers en base64
    const imageParts = await Promise.all(
      files.map(async (file) => {
        const base64 = await fileToBase64(file);
        return { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } };
      })
    );

    // Choisir le prompt : simple pour 1 fichier, unifié pour plusieurs
    const prompt = files.length === 1 ? PROMPT : PROMPT_DOSSIER;
    const result = await generateWithFallback(c.env, [prompt, ...imageParts]);
    const text = result.response.text();

    let data = null;
    let parseOk = false;
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      data = JSON.parse(cleaned);
      parseOk = true;
    } catch { /* ignore */ }

    // Log d'utilisation
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
      ...(parseOk ? {} : { reponse_brute: text, avertissement: "La réponse n'a pas pu être parsée en JSON structuré." }),
    });

  } catch (err) {
    if (c.env.DB) {
      await logUsageEvent(c.env.DB, {
        endpoint: "/analyse-bulletin",
        provider: "gemini",
        status: "error",
        nb_fichiers: 0,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    }
    return c.json({ success: false, erreur: err.message || "Erreur interne du serveur" }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /ocr
// ─────────────────────────────────────────────
app.post("/ocr", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file) {
      return c.json({ error: "Aucun fichier envoyé" }, 422);
    }

    const model = createModel(c.env);
    const base64 = await fileToBase64(file);

    const result = await model.generateContent([
      OCR_PROMPT,
      { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } },
    ]);

    const text = result.response.text();

    let data = null;
    let parseOk = false;
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      data = JSON.parse(cleaned);
      parseOk = true;
    } catch { /* ignore */ }

    if (c.env.DB) {
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "success",
        nb_fichiers: 1,
        duree_ms: Date.now() - startTime,
      }).catch(() => {});
    }

    return c.json({
      success: true,
      resultat: data,
      ...(parseOk ? {} : { reponse_brute: text, avertissement: "La réponse n'a pas pu être parsée en JSON structuré." }),
    });

  } catch (err) {
    if (c.env.DB) {
      await logUsageEvent(c.env.DB, {
        endpoint: "/ocr",
        provider: "gemini",
        status: "error",
        nb_fichiers: 0,
        duree_ms: Date.now() - startTime,
        error_message: err.message,
      }).catch(() => {});
    }
    return c.json({ success: false, erreur: err.message || "Erreur interne du serveur" }, 500);
  }
});

// ─────────────────────────────────────────────
// POST /valider
// Boucle de validation/feedback depuis le Front-End
// ─────────────────────────────────────────────
app.post("/valider", async (c) => {
  try {
    const body = await c.req.json();
    const { donnees_ia, metadata_validation } = body;

    if (!donnees_ia || !metadata_validation) {
      return c.json({
        success: false,
        erreur: "Le body doit contenir 'donnees_ia' et 'metadata_validation'.",
      }, 422);
    }

    const { statut_validation, erreurs_signalees, commentaires_correction } = metadata_validation;

    if (!statut_validation) {
      return c.json({
        success: false,
        erreur: "'metadata_validation.statut_validation' est requis.",
      }, 422);
    }

    // Persister dans D1
    const result = await c.env.DB.prepare(
      `INSERT INTO bulletins_valides (donnees_ia, statut_validation, erreurs_signalees, commentaires_correction)
       VALUES (?, ?, ?, ?)`
    )
      .bind(
        JSON.stringify(donnees_ia),
        statut_validation,
        JSON.stringify(erreurs_signalees || []),
        commentaires_correction || ""
      )
      .run();

    return c.json({
      success: true,
      message: "Feedback enregistré avec succès",
      id: result.meta.last_row_id,
      statut: statut_validation,
    });

  } catch (err) {
    return c.json({ success: false, erreur: err.message || "Erreur interne du serveur" }, 500);
  }
});

// ─────────────────────────────────────────────
// GET /bulletins — Lister les bulletins validés
// ─────────────────────────────────────────────
app.get("/bulletins", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM bulletins_valides ORDER BY created_at DESC LIMIT 100"
    ).all();

    return c.json({
      success: true,
      total: results.length,
      bulletins: results,
    });
  } catch (err) {
    return c.json({ success: false, erreur: err.message }, 500);
  }
});

// ─────────────────────────────────────────────
// GET /bulletins/:id
// ─────────────────────────────────────────────
app.get("/bulletins/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const bulletin = await c.env.DB
      .prepare("SELECT * FROM bulletins_valides WHERE id = ?")
      .bind(id)
      .first();

    if (!bulletin) {
      return c.json({ success: false, erreur: "Bulletin non trouvé" }, 404);
    }

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

// Endpoint compatible avec le projet Python (POST /ocr, un seul fichier, retourne du texte brut)
app.post("/ocr", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file) {
      return c.json({ error: "Aucun fichier envoyé" }, 422);
    }

    const base64 = await fileToBase64(file);

    const result = await generateWithFallback(c.env, [
      OCR_PROMPT,
      { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } },
    ]);

    const text = result.response.text();

    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const data = JSON.parse(cleaned);
      return c.json({
        success: true,
        resultat: data,
      });
    } catch {
      return c.json({
        success: true,
        resultat: null,
        reponse_brute: text,
        avertissement: "La réponse n'a pas pu être parsée en JSON structuré.",
      });
    }
  } catch (err) {
    return c.json({
      success: false,
      erreur: err.message || "Erreur interne du serveur",
    }, 500);
  }
});

/* ============================================================
   GEMINI VERSION (commentée) - Décommenter pour utiliser Gemini
   ============================================================

import { GoogleGenerativeAI } from "@google/generative-ai";

// Dans /analyse-bulletin :
const genAI = new GoogleGenerativeAI(c.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
const imageParts = files.map(file => ({
  inlineData: { data: base64, mimeType: file.type || "image/jpeg" }
}));
const result = await model.generateContent([PROMPT, ...imageParts]);
const text = result.response.text();

// Dans /ocr :
const result = await model.generateContent([
  "Extrais tout le texte visible dans cette image...",
  { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } },
]);
return c.json({ text: result.response.text() });

============================================================ */

export default app;
