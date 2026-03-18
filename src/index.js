import { Hono } from "hono";
import { cors } from "hono/cors";
// import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = new Hono();

app.use("/*", cors());

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

// Helper: convertir un fichier en base64
async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper: créer un client Gemini
function createModel(env) {
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
}

app.get("/", (c) => {
  return c.json({ message: "API OCR BH Assurance active" });
});

app.get("/openapi.json", (c) => {
  return c.json({
    openapi: "3.0.3",
    info: {
      title: "API OCR BH Assurance",
      description: "API d'extraction OCR de bulletins de soins BH Assurance via Claude AI",
      version: "1.0.0",
    },
    paths: {
      "/": {
        get: {
          summary: "Status de l'API",
          responses: {
            200: {
              description: "API active",
              content: { "application/json": { schema: { type: "object", properties: { message: { type: "string" } } } } },
            },
          },
        },
      },
      "/analyse-bulletin": {
        post: {
          summary: "Analyser un bulletin de soins",
          description: "Envoie une ou plusieurs images de bulletin de soins pour extraction OCR via Claude AI",
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
            200: {
              description: "Données extraites du bulletin",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      infos_adherent: {
                        type: "object",
                        properties: {
                          nom_prenom: { type: "string" },
                          numero_contrat: { type: "string" },
                          numero_bulletin: { type: "string" },
                          adresse: { type: "string" },
                          beneficiaire_coche: { type: "string" },
                          date_signature: { type: "string" },
                        },
                      },
                      volet_medical: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            date_acte: { type: "string" },
                            nature_acte: { type: "string" },
                            montant_honoraires: { type: "string" },
                            montant_facture: { type: "string" },
                            nom_praticien: { type: "string" },
                            matricule_fiscale: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            422: {
              description: "Aucun fichier envoyé",
              content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
            },
          },
        },
      },
      "/ocr": {
        post: {
          summary: "OCR simple",
          description: "Envoie une image et retourne le texte brut extrait (même interface que le projet Python)",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties: {
                    file: { type: "string", format: "binary", description: "Image à analyser (JPEG, PNG)" },
                  },
                  required: ["file"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "Texte extrait",
              content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } } } } },
            },
            422: {
              description: "Aucun fichier envoyé",
              content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } },
            },
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

app.post("/analyse-bulletin", async (c) => {
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
        return {
          inlineData: {
            data: base64,
            mimeType: file.type || "image/jpeg",
          },
        };
      })
    );

    const result = await model.generateContent([PROMPT, ...imageParts]);
    const text = result.response.text();

    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const data = JSON.parse(cleaned);
      return c.json({
        success: true,
        nombre_fichiers: files.length,
        resultat: data,
      });
    } catch {
      return c.json({
        success: true,
        nombre_fichiers: files.length,
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

// Endpoint compatible avec le projet Python (POST /ocr, un seul fichier, retourne du texte brut)
app.post("/ocr", async (c) => {
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
