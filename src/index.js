import { Hono } from "hono";
import { cors } from "hono/cors";
// import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = new Hono();

app.use("/*", cors());

const TYPES_SOINS_TUNISIE = [
  "consultation",
  "consultation specialisee",
  "analyse biologique",
  "analyse medicale",
  "radiologie",
  "echographie",
  "scanner",
  "IRM",
  "pharmacie",
  "chirurgie",
  "hospitalisation",
  "soins dentaires",
  "prothese dentaire",
  "optique",
  "lunettes",
  "lentilles",
  "kinesitherapie",
  "reeducation fonctionnelle",
  "soins ambulatoires",
  "accouchement",
  "maternite",
  "dialyse",
  "chimiotherapie",
  "radiotherapie",
  "cure thermale",
  "appareillage",
  "prothese orthopedique",
  "transport sanitaire",
  "soins infirmiers",
  "laboratoire",
  "medecine generale",
  "medecine de specialite",
];

const PROMPT = `Analyse ces images d'un bulletin de soins BH Assurance en Tunisie.
Extrais avec précision TOUTES les informations visibles, en particulier :
- Le numéro du bulletin de soins (souvent en haut du document)
- Le type de soin / nature de l'acte médical
- La matricule fiscale de chaque praticien (suite de chiffres/lettres identifiant fiscalement le praticien)

DÉTECTION ET EXTRACTION DU DOCUMENT CNAM :
- Si un document CNAM est présent (Décompte de remboursement des frais de soins de la Caisse Nationale d'Assurance Maladie), tu DOIS l'analyser et remplir le bloc "cnam" ci-dessous.
- Le document CNAM peut se présenter sous différents formats : décompte imprimé, relevé de remboursement, bordereau CNAM, attestation de prise en charge, notification de remboursement, etc.
- Identifie-le par les mots-clés : "CNAM", "Caisse Nationale d'Assurance Maladie", "Décompte de remboursement", "Mnt Remb", "Mnt à remb", "Total remboursé", "TotRemb".
- Extrais TOUTES les sections du décompte CNAM : Consultation & Visites, Actes, Médicaments, ou toute autre section présente.
- CROISEMENT CNAM ↔ ACTES : Pour chaque acte dans "volet_medical", cherche la ligne CNAM correspondante (même type de soin, même date, même montant) et remplis "montant_cnam" avec le montant remboursé CNAM. Si aucune correspondance → "".

EXTRACTION DES PIÈCES JUSTIFICATIVES (Ordonnances, Bilans, Reçus, etc.) :
- Pour chaque document justificatif présent dans les images, extrais ses informations dans le tableau "pieces_justificatives".
- Types de pièces à détecter : ORDONNANCE, BILAN, RECU, FACTURE, COMPTE_RENDU, AUTRE.
- Chaque pièce doit être rattachée à l'acte correspondant dans "volet_medical" via "rattachement_acte" (index commençant à 0). Si aucun rattachement possible → null.
- CROISEMENT ORDONNANCES ↔ PHARMACIE : Si une ordonnance prescrit des médicaments et qu'un ticket de pharmacie les liste, vérifie la cohérence et signale les écarts dans "observations".

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
  "infos_adherent": {
    "nom_prenom": "",
    "numero_adherent": "",
    "numero_contrat": "",
    "numero_bulletin": "",
    "adresse": "",
    "beneficiaire_coche": "",
    "nom_beneficiaire": "",
    "date_signature": ""
  },
  "volet_medical": [
    {
      "type_soin": "",
      "date_acte": "",
      "nature_acte": "",
      "montant_honoraires": "",
      "montant_facture": "",
      "nom_praticien": "",
      "matricule_fiscale": "",
      "montant_cnam": ""
    }
  ],
  "cnam": {
    "numero_assure": "",
    "caisse": "",
    "beneficiaire": "",
    "regime": "",
    "ref_paiement": "",
    "date_decompte": "",
    "details_remboursement": [
      {
        "categorie": "Consultation & Visites | Actes | Médicaments | autre section",
        "lignes": [
          {
            "code": "",
            "designation": "",
            "quantite": "",
            "date": "",
            "montant_depense": "",
            "montant_rembourse": "",
            "decision": ""
          }
        ]
      }
    ],
    "total_depense": "",
    "total_rembourse": ""
  },
  "pieces_justificatives": [
    {
      "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | AUTRE",
      "rattachement_acte": null,
      "praticien": "",
      "date": "",
      "contenu": {
        "medicaments_prescrits": [
          {
            "nom": "",
            "posologie": "",
            "duree": "",
            "quantite": ""
          }
        ],
        "resultats_bilan": [
          {
            "parametre": "",
            "valeur": "",
            "unite": "",
            "norme": ""
          }
        ],
        "texte_libre": ""
      },
      "montant": "",
      "observations": ""
    }
  ]
}

IMPORTANT :
- "nom_prenom" : le nom et prénom de l'adhérent. C'est un document TUNISIEN, donc les noms sont des noms arabes/tunisiens.
  RÈGLES CRITIQUES pour la lecture des noms manuscrits :
  1. ATTENTION aux lettres similaires en écriture manuscrite : 'm' et 'n', 'l' et 'i', 'u' et 'v', 'rn' et 'm', 'k' et 'h', 'e' et 'c'.
  2. Si le texte est en majuscules, convertis en "Nom Prenom" (première lettre majuscule).
  3. Corrige automatiquement vers un nom tunisien connu si la lecture est ambiguë. Exemples de noms de famille tunisiens courants : Mekki, Meddeb, Ben Ali, Bouazizi, Trabelsi, Gharbi, Jebali, Hammami, Mansouri, Chaabane, Karoui, Sassi, Haddad, Mejri, Dridi, Khemiri, Abidi, Jaziri, Amri, Brahmi, Belhadj, Rezgui, Laabidi, Ferchichi, Bouzid, Ayari, Mbarki, Nefzi, Riahi, Saidi, Khalfi, Baccouche, Ghannouchi, Essid, Marzouki, Naifer, Kefi, Gouider.
  Exemples de prénoms tunisiens courants : Mohamed, Ahmed, Ali, Fatma, Imen, Dhekra, Amira, Sana, Hela, Rania, Yassine, Sirine, Nour, Hichem, Amine, Karim, Sami, Nabil, Riadh, Mourad, Walid, Slim, Hatem, Ons, Mariem, Asma, Emna, Rim, Ines, Olfa.
  4. IMPORTANT : "nekk" n'est PAS un nom tunisien, c'est probablement "Mekki". "nohaned" est probablement "Mohamed". Toujours vérifier si le résultat ressemble à un vrai nom tunisien.
- "numero_adherent" : le numéro d'adhérent, souvent en haut du document ou à côté du nom de l'assuré.
- "numero_bulletin" : le numéro imprimé sur le bulletin de soins.
- "type_soin" : le type de soin selon le système de santé tunisien. Les valeurs possibles sont : ${TYPES_SOINS_TUNISIE.join(", ")}. Cherche cette information dans la colonne "Nature de l'acte", dans les cases cochées, ou dans les intitulés du document. Si le document indique "médecin" ou "docteur" sans précision, mettre "consultation". Si c'est un labo, mettre "analyse biologique". Si c'est une clinique avec séjour, mettre "hospitalisation".
- "nature_acte" : description plus détaillée de l'acte (ex: "consultation cardiologie", "analyse sang NFS", "radio thorax").
- "matricule_fiscale" : la matricule fiscale du praticien, souvent un code alphanumérique. Cherche attentivement dans le document, elle peut être dans un tableau ou à côté du nom du praticien.
- "beneficiaire_coche" : indique quel bénéficiaire est coché (ex: "Adhérent", "Conjoint", "Enfant"). Si la case cochée est "Enfant" ou "Conjoint", remplis "nom_beneficiaire" avec le nom et prénom complet du malade écrit dans la section "PARTIE A REMPLIR PAR LE PRATICIEN" au champ "Nom et Prénom du malade". Ce nom est différent de celui de l'adhérent. Si la case est "Adhérent" ou aucune case cochée, laisse "nom_beneficiaire" vide "".
- "montant_honoraires" : le montant des honoraires du praticien. Fais très attention à lire correctement les chiffres manuscrits, notamment la distinction entre 0 et 6, 1 et 7, 5 et 8. Respecte le format avec virgule ou point décimal tel qu'il apparaît.
- "montant_cnam" : montant remboursé par la CNAM pour cet acte. Remplis UNIQUEMENT si un décompte CNAM est présent. Sinon "".
- "cnam" : remplis ce bloc UNIQUEMENT si un document CNAM (décompte de remboursement) est présent dans les images. Si aucun document CNAM → ne mets pas la clé "cnam".
- "pieces_justificatives" : remplis ce tableau UNIQUEMENT si des documents justificatifs (ordonnances, bilans, reçus, factures, comptes-rendus) sont présents. Si aucun → tableau vide []. Dans "contenu", remplis UNIQUEMENT les sous-clés pertinentes au type : "medicaments_prescrits" pour ORDONNANCE, "resultats_bilan" pour BILAN, "texte_libre" pour COMPTE_RENDU/AUTRE. Supprime les sous-clés non pertinentes.
- Si un champ est VIDE sur le document (rien n'est écrit), laisse une chaîne vide "".
- Si un champ est REMPLI mais pas lisible (écriture illisible, scan flou), mets "illisible".
- Ne confonds pas un champ vide avec un champ illisible.`;

const OCR_PROMPT = `Analyse cette image d'un bulletin de soins BH Assurance en Tunisie.
Extrais avec précision TOUTES les informations visibles sur le document.

DÉTECTION ET EXTRACTION DU DOCUMENT CNAM :
- Si le document est un décompte CNAM (Caisse Nationale d'Assurance Maladie), remplis le bloc "cnam".
- Identifie-le par : "CNAM", "Décompte de remboursement", "Mnt Remb", "Total remboursé", "TotRemb".
- Extrais toutes les sections (Consultation & Visites, Actes, Médicaments) avec leurs lignes et totaux.

DÉTECTION DES PIÈCES JUSTIFICATIVES :
- Si le document est une ordonnance, un bilan, un reçu, une facture ou un compte-rendu, remplis "pieces_justificatives".

Retourne UNIQUEMENT ce JSON sans texte supplémentaire :

{
  "infos_adherent": {
    "nom_prenom": "",
    "numero_adherent": "",
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
    "nom_beneficiaire": "",
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
      "type_soin": "",
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
      "date_facture": "",
      "montant_cnam": ""
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
  "cnam": {
    "numero_assure": "",
    "caisse": "",
    "beneficiaire": "",
    "regime": "",
    "ref_paiement": "",
    "date_decompte": "",
    "details_remboursement": [
      {
        "categorie": "",
        "lignes": [
          {
            "code": "",
            "designation": "",
            "quantite": "",
            "date": "",
            "montant_depense": "",
            "montant_rembourse": "",
            "decision": ""
          }
        ]
      }
    ],
    "total_depense": "",
    "total_rembourse": ""
  },
  "pieces_justificatives": [
    {
      "type_piece": "ORDONNANCE | BILAN | RECU | FACTURE | COMPTE_RENDU | AUTRE",
      "rattachement_acte": null,
      "praticien": "",
      "date": "",
      "contenu": {
        "medicaments_prescrits": [
          {
            "nom": "",
            "posologie": "",
            "duree": "",
            "quantite": ""
          }
        ],
        "resultats_bilan": [
          {
            "parametre": "",
            "valeur": "",
            "unite": "",
            "norme": ""
          }
        ],
        "texte_libre": ""
      },
      "montant": "",
      "observations": ""
    }
  ],
  "totaux": {
    "total_honoraires": "",
    "total_factures": "",
    "total_rembourse": "",
    "total_reste_a_charge": "",
    "total_cnam": ""
  },
  "observations": ""
}

IMPORTANT :
- "nom_prenom" : le nom et prénom de l'adhérent. C'est un document TUNISIEN, donc les noms sont des noms arabes/tunisiens.
  RÈGLES CRITIQUES pour la lecture des noms manuscrits :
  1. ATTENTION aux lettres similaires en écriture manuscrite : 'm' et 'n', 'l' et 'i', 'u' et 'v', 'rn' et 'm', 'k' et 'h', 'e' et 'c'.
  2. Si le texte est en majuscules, convertis en "Nom Prenom" (première lettre majuscule).
  3. Corrige automatiquement vers un nom tunisien connu si la lecture est ambiguë. Exemples de noms de famille tunisiens courants : Mekki, Meddeb, Ben Ali, Bouazizi, Trabelsi, Gharbi, Jebali, Hammami, Mansouri, Chaabane, Karoui, Sassi, Haddad, Mejri, Dridi, Khemiri, Abidi, Jaziri, Amri, Brahmi, Belhadj, Rezgui, Laabidi, Ferchichi, Bouzid, Ayari, Mbarki, Nefzi, Riahi, Saidi, Khalfi, Baccouche, Ghannouchi, Essid, Marzouki, Naifer, Kefi, Gouider.
  Exemples de prénoms tunisiens courants : Mohamed, Ahmed, Ali, Fatma, Imen, Dhekra, Amira, Sana, Hela, Rania, Yassine, Sirine, Nour, Hichem, Amine, Karim, Sami, Nabil, Riadh, Mourad, Walid, Slim, Hatem, Ons, Mariem, Asma, Emna, Rim, Ines, Olfa.
  4. IMPORTANT : "nekk" n'est PAS un nom tunisien, c'est probablement "Mekki". "nohaned" est probablement "Mohamed". Toujours vérifier si le résultat ressemble à un vrai nom tunisien.
- "numero_adherent" : le numéro d'adhérent, souvent en haut du document ou à côté du nom de l'assuré.
- "numero_bulletin" : le numéro imprimé sur le bulletin de soins.
- "type_soin" : le type de soin selon le système de santé tunisien. Les valeurs possibles sont : ${TYPES_SOINS_TUNISIE.join(", ")}. Cherche cette information dans la colonne "Nature de l'acte", dans les cases cochées, ou dans les intitulés du document. Si le document indique "médecin" ou "docteur" sans précision, mettre "consultation". Si c'est un labo, mettre "analyse biologique". Si c'est une clinique avec séjour, mettre "hospitalisation".
- "nature_acte" : description plus détaillée de l'acte (ex: "consultation cardiologie", "analyse sang NFS", "radio thorax").
- "matricule_fiscale" : la matricule fiscale du praticien, souvent un code alphanumérique.
- "beneficiaire_coche" : indique quel bénéficiaire est coché (ex: "Adhérent", "Conjoint", "Enfant"). Si la case cochée est "Enfant" ou "Conjoint", remplis "nom_beneficiaire" avec le nom et prénom complet du malade écrit dans la section "PARTIE A REMPLIR PAR LE PRATICIEN" au champ "Nom et Prénom du malade". Ce nom est différent de celui de l'adhérent. Si la case est "Adhérent" ou aucune case cochée, laisse "nom_beneficiaire" vide "".
- "montant_honoraires" : le montant des honoraires du praticien. Fais très attention à lire correctement les chiffres manuscrits, notamment la distinction entre 0 et 6, 1 et 7, 5 et 8. Respecte le format avec virgule ou point décimal tel qu'il apparaît.
- "montant_cnam" : montant remboursé par la CNAM pour cet acte. Remplis UNIQUEMENT si un décompte CNAM est présent. Sinon "".
- "cnam" : remplis ce bloc UNIQUEMENT si un document CNAM est présent. Si aucun → ne mets pas la clé "cnam".
- "pieces_justificatives" : remplis UNIQUEMENT si des documents justificatifs sont présents. Si aucun → tableau vide []. Dans "contenu", remplis UNIQUEMENT les sous-clés pertinentes : "medicaments_prescrits" pour ORDONNANCE, "resultats_bilan" pour BILAN, "texte_libre" pour COMPTE_RENDU/AUTRE.
- "pharmacie" : si des médicaments sont listés séparément, les mettre dans cette section.
- "totaux" : les montants totaux si visibles en bas du document. "total_cnam" = total remboursé CNAM si décompte présent, sinon "".
- "observations" : toute remarque ou note manuscrite visible sur le document.
- Si une section n'existe pas dans le document, retourne un tableau vide [] ou un objet vide {}.
- Si un champ est VIDE sur le document (rien n'est écrit), laisse une chaîne vide "".
- Si un champ est REMPLI mais pas lisible (écriture illisible, scan flou), mets "illisible".
- Ne confonds pas un champ vide avec un champ illisible.`;

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
