// src/index.js
// API OCR BH Assurance — Cloudflare Workers + Hono
// Inclut la plateforme d'administration (point 3)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "./admin.js";
import { logUsageEvent } from "./stats.js";

const app = new Hono();

app.use("/*", cors());

// ─────────────────────────────────────────────
// Monter la plateforme d'administration
// Route : /admin/**
// ─────────────────────────────────────────────
app.route("/admin", admin);

// ─────────────────────────────────────────────
// Prompts OCR
// ─────────────────────────────────────────────
const PROMPT = `Analyse ces images d'un bulletin de soins BH Assurance.
Extrais avec précision TOUTES les informations visibles, en particulier :
- Le numéro du bulletin de soins (souvent en haut du document)
- La nature de l'acte médical (consultation, analyse, radiologie, chirurgie, pharmacie, etc.)
- La matricule fiscale de chaque praticien (suite de chiffres/lettres identifiant fiscalement le praticien)

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
  "infos_adherent": {
    "nom_prenom": "",
    "numero_contrat": "",
    "numero_bulletin": "",
    "adresse": "",
    "beneficiaire_coche": "",
    "date_signature": ""
  },
  "volet_medical": [
    {
      "date_acte": "",
      "nature_acte": "",
      "montant_honoraires": "",
      "montant_facture": "",
      "nom_praticien": "",
      "matricule_fiscale": ""
    }
  ]
}

IMPORTANT :
- "numero_bulletin" : le numéro imprimé sur le bulletin de soins.
- "nature_acte" : la nature de l'acte médical (ex: consultation, analyse biologique, radiologie, pharmacie, chirurgie, soins dentaires, etc.). Cherche dans la colonne "Nature de l'acte" du tableau.
- "matricule_fiscale" : la matricule fiscale du praticien, souvent un code alphanumérique. Cherche attentivement dans le document, elle peut être dans un tableau ou à côté du nom du praticien.
- Si une valeur n'est pas lisible, mets "illisible". Ne laisse jamais un champ vide.`;

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

function createModel(env) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

// ─────────────────────────────────────────────
// Routes publiques
// ─────────────────────────────────────────────
app.get("/", (c) => {
  return c.json({
    message: "API OCR BH Assurance active",
    version: "2.0.0",
    endpoints: [
      "POST /analyse-bulletin",
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
          summary: "Analyser un bulletin de soins",
          description: "Envoie une ou plusieurs images de bulletin de soins pour extraction OCR via Gemini AI",
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
                      description: "Images du bulletin de soins (JPEG, PNG)",
                    },
                  },
                  required: ["files"],
                },
              },
            },
          },
          responses: {
            200: { description: "Données extraites du bulletin" },
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
// POST /analyse-bulletin
// ─────────────────────────────────────────────
app.post("/analyse-bulletin", async (c) => {
  const startTime = Date.now();
  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files");

    if (!files || files.length === 0) {
      return c.json({ error: "Aucun fichier envoyé" }, 422);
    }

    const model = createModel(c.env);

    const imageParts = await Promise.all(
      files.map(async (file) => {
        const base64 = await fileToBase64(file);
        return { inlineData: { data: base64, mimeType: file.type || "image/jpeg" } };
      })
    );

    const result = await model.generateContent([PROMPT, ...imageParts]);
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

export default app;
