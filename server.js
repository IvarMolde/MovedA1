require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── AUTH ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  const cookie = req.headers.cookie || "";
  if (cookie.includes("auth=ok")) return next();
  res.redirect("/login");
}

// ── DATA ─────────────────────────────────────────────
let kapitler = [];
try {
  kapitler = JSON.parse(fs.readFileSync(path.join(__dirname, "data/kapitler.json"), "utf8"));
} catch (e) {
  try {
    kapitler = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/kapitler.json"), "utf8"));
  } catch (e2) { console.error("Feil: kapitler.json", e2.message); }
}

let orddata = {};
try {
  orddata = JSON.parse(fs.readFileSync(path.join(__dirname, "data/orddata.json"), "utf8"));
} catch (e) {
  try {
    orddata = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/orddata.json"), "utf8"));
  } catch (e2) { console.error("Feil: orddata.json", e2.message); }
}

// ── HJELPEFUNKSJON: Berik ordliste ───────────────────
function berikOrdliste(ordliste) {
  return ordliste.map(ord => {
    const data = orddata[ord.toLowerCase()] || orddata[ord] || null;
    if (!data) return { ord, display: ord, klasse: "ukjent", bøyning: "" };
    return { ord, display: data.display, klasse: data.klasse, bøyning: data.bøyning };
  });
}

// ── ROUTES: AUTH ──────────────────────────────────────
app.get("/login", (req, res) => {
  if ((req.headers.cookie || "").includes("auth=ok")) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/login", (req, res) => {
  const { passord } = req.body;
  if (passord === process.env.APP_PASSORD) {
    res.setHeader("Set-Cookie", "auth=ok; Path=/; HttpOnly; Max-Age=28800; SameSite=Lax");
    res.redirect("/");
  } else {
    res.redirect("/login?feil=1");
  }
});

app.get("/logg-ut", (req, res) => {
  res.setHeader("Set-Cookie", "auth=ok; Path=/; HttpOnly; Max-Age=0; SameSite=Lax");
  res.redirect("/login");
});

// ── ROUTES: SIDER ────────────────────────────────────
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/kapittel/:id", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public/kapittel.html")));
app.get("/grammatikk", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public/grammatikk.html")));

// ── API: KAPITLER ─────────────────────────────────────
app.get("/api/kapitler", requireAuth, (req, res) => res.json(kapitler));

app.get("/api/kapitler/:id", requireAuth, (req, res) => {
  const kap = kapitler.find(k => k.id === parseInt(req.params.id));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });
  // Berik ordlisten med grammatikkdata
  const beriketKap = { ...kap, ordlisteBeriket: berikOrdliste(kap.ordliste) };
  res.json(beriketKap);
});

// ── API: GENERER INNHOLD (streaming) ─────────────────
app.post("/api/generer", requireAuth, async (req, res) => {
  const { kapittelId, leksjon, type, yrke, nivaa = "A1" } = req.body;
  if (!kapittelId || !type) return res.status(400).json({ error: "Mangler kapittelId eller type" });
  const kap = kapitler.find(k => k.id === parseInt(kapittelId));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });

  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = byggPrompt({ kap, leksjon, type, yrke, nivaa });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");

    const streamResult = await model.generateContentStream(prompt);
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) res.write(text);
    }
    res.end();
  } catch (err) {
    console.error("Gemini feil:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Generering feilet. Prøv igjen." });
  }
});

// ── API: GENERER WORD (.docx) ────────────────────────
app.post("/api/generer-docx", requireAuth, async (req, res) => {
  const { kapittelId, innhold, type, genData } = req.body;
  const kap = kapitler.find(k => k.id === parseInt(kapittelId));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });

  try {
    const docxBuffer = await genererDOCX({ kap, innhold, type, genData });
    const filnavn = `kap${kap.id}_${kap.tittel.replace(/\s+/g, "_").toLowerCase()}.docx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filnavn}"`);
    res.send(docxBuffer);
  } catch (err) {
    console.error("DOCX feil:", err.message);
    res.status(500).json({ error: "Word-generering feilet: " + err.message });
  }
});

// ── API: GENERER PPTX ────────────────────────────────
app.post("/api/generer-pptx", requireAuth, async (req, res) => {
  const { kapittelId, tittel, innhold, grammatikk, oppgaver } = req.body;
  const kap = kapitler.find(k => k.id === parseInt(kapittelId));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });

  try {
    const pptxBuffer = await genererPPTX({ kap, tittel, innhold, grammatikk, oppgaver });
    const filnavn = `norsk_${kap.tittel.replace(/\s+/g, "_").toLowerCase()}.pptx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${filnavn}"`);
    res.send(pptxBuffer);
  } catch (err) {
    console.error("PPTX feil:", err.message);
    res.status(500).json({ error: "PPTX-generering feilet." });
  }
});

// ── API: HELSE ───────────────────────────────────────
app.get("/api/helse", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// ── PROMPT-BYGGER ─────────────────────────────────────

// ── API: GENERER TEKST + OPPGAVER (kombinert) ────────
app.post("/api/generer-komplett", requireAuth, async (req, res) => {
  const { kapittelId, leksjon, type, yrke, nivaa = "A1" } = req.body;
  if (!kapittelId || !type) return res.status(400).json({ error: "Mangler data" });
  const kap = kapitler.find(k => k.id === parseInt(kapittelId));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });

  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const leksjonTekst = leksjon
      ? `Leksjon ${leksjon}: ${kap.leksjoner.find(l => l.id === leksjon)?.tittel || leksjon}`
      : `Hele kapittelet: ${kap.tittel}`;
    const yrkeTekst = yrke ? `\nElevenes yrkesbakgrunn: ${yrke}` : "";

    const prompt = `Du er en erfaren norsklærer ved Molde voksenopplæringssenter (MOVED).
Du lager undervisningsmateriell for CEFR-nivå ${nivaa} for voksne innvandrere (25–55 år).

VIKTIGE REGLER:
- Kun bokmål. Ingen morsmålsstøtte.
- Aldersadekvat – IKKE barnetema. Voksne i realistiske situasjoner.
- Enkelt språk: A1 = maks 7 ord per setning.
- Bruk ord fra kapittelets nøkkelord der det passer naturlig.

KAPITTELKONTEKST:
Kapittel ${kap.id}: ${kap.tittel}
${leksjonTekst}
Kommunikative mål: ${kap.funksjoner.join(", ")}
Grammatikk: ${kap.grammatikk.join(", ")}
Nøkkelord: ${kap.ordliste.join(", ")}${yrkeTekst}

OPPGAVE: Lag en komplett leksjon som inneholder BEGGE deler:

DEL 1 – LESETEKST (60–80 ord):
En kort tekst om en voksen person i en situasjon knyttet til kapittelet.
Hvis type er "yrkestekst": teksten skal handle om en person i jobben sin.
Bruk enkle setninger. Teksten er grunnlaget for alle oppgavene i del 2.

DEL 2 – INTERAKTIVE OPPGAVER basert på teksten over:
Lag NØYAKTIG dette JSON-objektet (ingen tekst utenfor JSON):

{
  "lesetekst": "Hele leseteksten her som én streng",
  "mc": [
    {"spm": "Spørsmål basert på teksten?", "alternativer": ["Svar A", "Svar B", "Svar C", "Svar D"], "riktig": 0},
    {"spm": "...", "alternativer": ["...", "...", "...", "..."], "riktig": 1},
    {"spm": "...", "alternativer": ["...", "...", "...", "..."], "riktig": 2},
    {"spm": "...", "alternativer": ["...", "...", "...", "..."], "riktig": 0},
    {"spm": "...", "alternativer": ["...", "...", "...", "..."], "riktig": 1}
  ],
  "fyll_inn": [
    {"for": "tekst før tomrom", "etter": "tekst etter tomrom", "svar": "riktig ord", "hint": "(ordklasse)"},
    {"for": "...", "etter": "...", "svar": "...", "hint": "..."},
    {"for": "...", "etter": "...", "svar": "...", "hint": "..."},
    {"for": "...", "etter": "...", "svar": "...", "hint": "..."},
    {"for": "...", "etter": "...", "svar": "...", "hint": "..."}
  ],
  "sant_usant": [
    {"pastand": "Påstand basert på teksten.", "riktig": true},
    {"pastand": "...", "riktig": false},
    {"pastand": "...", "riktig": true},
    {"pastand": "...", "riktig": false},
    {"pastand": "...", "riktig": true},
    {"pastand": "...", "riktig": false}
  ],
  "ordstilling": [
    {"ord": ["Verb", "Subjekt", "objekt", "adverb"], "riktig": "Subjekt Verb objekt adverb"},
    {"ord": ["...", "...", "...", "..."], "riktig": "..."},
    {"ord": ["...", "...", "...", "..."], "riktig": "..."},
    {"ord": ["...", "...", "..."], "riktig": "..."}
  ],
  "koble_par": [
    {"nor": "norsk ord/uttrykk fra teksten", "forklaring": "enkel norsk forklaring"},
    {"nor": "...", "forklaring": "..."},
    {"nor": "...", "forklaring": "..."},
    {"nor": "...", "forklaring": "..."},
    {"nor": "...", "forklaring": "..."},
    {"nor": "...", "forklaring": "..."}
  ],
  "diktat": [
    "Setning 1 fra teksten.",
    "Setning 2 fra teksten.",
    "Setning 3 fra teksten.",
    "Setning 4 fra teksten."
  ],
  "laringsmaal": [
    "Jeg kan [konkret kommunikativt mål fra kapittelet].",
    "Jeg kan [konkret grammatisk mål fra kapittelet].",
    "Jeg kan [konkret praktisk mål fra kapittelet]."
  ],
  "fasit": {
    "fyll_inn": ["svar1", "svar2", "svar3", "svar4", "svar5"],
    "sant_usant": [true, false, true, false, true, false],
    "ordstilling": ["Riktig setning 1", "Riktig setning 2", "Riktig setning 3", "Riktig setning 4"],
    "mc_forklaring": ["Kort forklaring til svar 1", "Kort forklaring til svar 2", "Kort forklaring til svar 3", "Kort forklaring til svar 4", "Kort forklaring til svar 5"]
  },
  "bilde_forslag": [
    "[BILDE: beskrivelse av relevant bilde for leseteksten]",
    "[BILDE: beskrivelse av relevant bilde for ordlisten]"
  ]
}

KRITISK: Svar KUN med det rene JSON-objektet. Ingen forklaring, ingen markdown, ingen backtick-blokker.`;

    const result = await model.generateContent(prompt);
    const rawText = result.response.text().trim();

    // Parse JSON – fjern eventuelle markdown-backticks
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const data = JSON.parse(cleaned);

    res.json({ ok: true, data });
  } catch (err) {
    console.error("Komplett-generering feil:", err.message);
    res.status(500).json({ error: "Generering feilet: " + err.message });
  }
});

function byggPrompt({ kap, leksjon, type, yrke, nivaa }) {
  const leksjonTekst = leksjon
    ? `Leksjon ${leksjon}: ${kap.leksjoner.find(l => l.id === leksjon)?.tittel || leksjon}`
    : `Hele kapittelet: ${kap.tittel}`;
  const yrkeTekst = yrke ? `\nElevenes yrkesbakgrunn: ${yrke}` : "";
  const typeInstruksjon = {
    lesetekst: `Lag en kort lesetekst (maks 80 ord) om temaet. Bruk enkle setninger (maks 7 ord). Inkluder 5 leseforståelsesspørsmål (a–e) etterpå. Teksten skal handle om en voksen person i en realistisk hverdagssituasjon – IKKE barnetema.`,
    arbeidsark: `Lag et komplett arbeidsark med: 1) Læringsmål (2–3 punkter med «Etter denne timen kan jeg...»), 2) Ordliste med 8 nøkkelord og forklaring på enkel norsk, 3) Fem varierte oppgaver (a–e): fyll inn, sant/usant, koble par, skriv setning, muntlig øvelse. Aldersadekvat innhold for voksne.`,
    grammatikk: `Lag en grammatikkøvelse om: ${kap.grammatikk.join(", ")}. Inkluder: 1) Enkel regelforklaring (3–4 setninger), 2) Tre eksempler i kontekst, 3) Åtte øvingssetninger (fyll inn riktig form), 4) Fasit. Bruk ord fra kapittelet.`,
    samtale: `Lag en strukturert samtaleøvelse for par. Inkluder: 1) Situasjonsbeskrivelse, 2) Nyttige fraser/uttrykk (8 setninger), 3) Dialogstarter A og B med noen faste fraser og noen åpne felt, 4) To oppfølgingsspørsmål til hele klassen. Tema skal være realistisk for voksne.`,
    yrkestekst: (() => {
      const vanligeYrker = [
        "sykepleier", "renholder", "bussjåfør", "kokk", "butikkmedarbeider",
        "barnehageassistent", "lagermedarbeider", "snekker", "elektriker",
        "servitør", "taxisjåfør", "vaktmester", "hjemmehjelp", "postbud",
        "frisør", "baker", "mekaniker", "gartnere", "sikkerhetsvakt"
      ];
      const valgtYrke = yrke && yrke.trim()
        ? yrke.trim()
        : vanligeYrker[Math.floor(Math.random() * vanligeYrker.length)];
      return `Lag en yrkestekst om en person som jobber som ${valgtYrke}. Bruk ord og situasjoner fra kapittelet. Inkluder: 1) En kort presentasjonstekst (60 ord, jeg-form) der personen forteller om jobben sin, 2) 5 yrkesspesifikke ord med forklaring på enkel norsk, 3) Tre oppgaver knyttet til yrkeskontekst (a–c). Aldersadekvat innhold for voksne.`;
    })(),
  }[type] || "Lag relevant undervisningsmateriell for dette kapittelet.";

  return `Du er en erfaren norsklærer ved Molde voksenopplæringssenter (MOVED).
Du lager undervisningsmateriell for CEFR-nivå ${nivaa} for voksne innvandrere (25–55 år).

VIKTIGE REGLER:
- Kun bokmål
- Ingen morsmålsstøtte
- Aldersadekvat innhold – IKKE barnetema, IKKE barnebilder
- Enkelt og tydelig språk (A1: maks 7 ord per setning)
- Grammatikk integrert i kontekst, ikke isolerte regler
- Oppgaver delt inn i a–e

KAPITTELKONTEKST:
Kapittel ${kap.id}: ${kap.tittel}
${leksjonTekst}
Kommunikative mål: ${kap.funksjoner.join(", ")}
Grammatikk i kapittelet: ${kap.grammatikk.join(", ")}
Nøkkelord: ${kap.ordliste.join(", ")}${yrkeTekst}

OPPGAVE:
${typeInstruksjon}

Svar direkte med innholdet – ingen forklaring eller metakommentar.`;
}

// ── WORD-GENERERING (.docx) ──────────────────────────
async function genererDOCX({ kap, innhold, type, genData }) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
    LevelFormat, VerticalAlign
  } = require("docx");

  const NAVY = "1B3A5C";
  const GOLD = "C9960C";
  const LIGHT_BLUE = "D6E4F0";
  const LIGHT_GREEN = "EAF4EA";
  const LIGHT_YELLOW = "FFF3CD";
  const LIGHT_GREY = "F5F5F5";
  const WHITE = "FFFFFF";

  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  // Berik ordlisten
  const beriketOrd = berikOrdliste(kap.ordliste);

  // ── TOPPTEKST-TABELL ──
  const topptekst = new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: [9026],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: noBorders,
            shading: { fill: NAVY, type: ShadingType.CLEAR },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
            width: { size: 9026, type: WidthType.DXA },
            children: [
              new Paragraph({
                children: [new TextRun({ text: "Molde voksenopplæringssenter – MBO", color: WHITE, bold: true, size: 26, font: "Arial" })],
              }),
              new Paragraph({
                children: [new TextRun({ text: `Tema: ${kap.tittel}   |   Nivå: A1`, color: WHITE, size: 22, font: "Arial" })],
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: "Navn: ________________________________   ", color: WHITE, size: 22, font: "Arial" }),
                  new TextRun({ text: "Dato: ____________", color: WHITE, size: 22, font: "Arial" }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  // ── LÆRINGSMÅL-SEKSJON ──
  const laringsmaalHeader = new Paragraph({
    children: [new TextRun({ text: "🎯 Læringsmål", bold: true, size: 26, font: "Arial", color: NAVY })],
    spacing: { before: 240, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 1 } },
  });

  // Dynamiske læringsmål fra Gemini (eller fallback)
  const lmaal = (genData && genData.laringsmaal && genData.laringsmaal.length)
    ? genData.laringsmaal
    : [`Jeg kan bruke nøkkelord fra kapittelet: ${kap.tittel}.`, `Jeg kan kommunisere om: ${kap.funksjoner[0]}.`, `Jeg kan lese og forstå en enkel tekst om dette temaet.`];

  const laringsmaalBoks = new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: [9026],
    rows: [new TableRow({
      children: [new TableCell({
        borders: noBorders,
        shading: { fill: LIGHT_BLUE, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 180, right: 180 },
        width: { size: 9026, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: "Etter denne timen kan jeg:", bold: true, size: 22, font: "Arial", color: NAVY })], spacing: { after: 80 } }),
          ...lmaal.map(m => new Paragraph({ children: [new TextRun({ text: `✓  ${m}`, size: 22, font: "Arial" })], spacing: { after: 40 } })),
        ],
      })],
    })],
  });

  // ── ORDLISTE-SEKSJON ──
  const ordlisteHeader = new Paragraph({
    children: [new TextRun({ text: "📝 Ordliste", bold: true, size: 26, font: "Arial", color: NAVY })],
    spacing: { before: 280, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 1 } },
  });

  // Tabell med ordliste: display | bøyning | egne notater
  const ordlisteHeader2 = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({
        borders, shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 2800, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: "Ord", bold: true, color: WHITE, size: 20, font: "Arial" })] })],
      }),
      new TableCell({
        borders, shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 3626, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: "Bøyning", bold: true, color: WHITE, size: 20, font: "Arial" })] })],
      }),
      new TableCell({
        borders, shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 2600, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: "Mine notater", bold: true, color: WHITE, size: 20, font: "Arial" })] })],
      }),
    ],
  });

  const ordlisteRader = beriketOrd.map((o, idx) => new TableRow({
    children: [
      new TableCell({
        borders,
        shading: { fill: idx % 2 === 0 ? LIGHT_GREEN : WHITE, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 2800, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: o.display, bold: true, size: 20, font: "Arial", color: NAVY })] })],
      }),
      new TableCell({
        borders,
        shading: { fill: idx % 2 === 0 ? LIGHT_GREEN : WHITE, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 3626, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: o.bøyning || "–", size: 20, font: "Arial", italics: true, color: "444444" })] })],
      }),
      new TableCell({
        borders,
        shading: { fill: idx % 2 === 0 ? LIGHT_GREEN : WHITE, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        width: { size: 2600, type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: "", size: 20, font: "Arial" })] })],
      }),
    ],
  }));

  const ordliste = new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: [2800, 3626, 2600],
    rows: [ordlisteHeader2, ...ordlisteRader],
  });

  // ── BILDEPLASSERINGER ──
  const bildeParagrafer = [];
  const bilder = (genData && genData.bilde_forslag) ? genData.bilde_forslag : [];
  if (bilder.length > 0) {
    bildeParagrafer.push(
      new Paragraph({ children: [new TextRun({ text: "🖼️ Bildeplasseringer", bold: true, size: 26, font: "Arial", color: NAVY })], spacing: { before: 200, after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: GOLD, space: 1 } } })
    );
    bilder.forEach(b => {
      bildeParagrafer.push(
        new Table({
          width: { size: 9026, type: WidthType.DXA }, columnWidths: [9026],
          rows: [new TableRow({ children: [new TableCell({
            borders: noBorders, width: { size: 9026, type: WidthType.DXA },
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            shading: { fill: "F0F0F0", type: ShadingType.CLEAR },
            children: [new Paragraph({ children: [new TextRun({ text: b, size: 20, font: "Arial", color: "555555", italics: true })] })]
          })] })]
        })
      );
    });
  }

  // ── INNHOLD FRA AI ──
  const innholdHeader = new Paragraph({
    children: [new TextRun({ text: "✏️ Oppgaver", bold: true, size: 26, font: "Arial", color: NAVY })],
    spacing: { before: 280, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 1 } },
  });

  // Parse innholdet linje for linje
  const innholdLinjer = (innhold || "Innhold ikke generert ennå. Generer tekst i portalen og last ned på nytt.")
    .split("\n")
    .filter(l => l.trim());

  const innholdParagrafer = innholdLinjer.map(linje => {
    const erOverskrift = /^#{1,3}\s/.test(linje) || /^[A-ZÆØÅ].*:$/.test(linje.trim());
    const erOppgave = /^[a-e][.)]\s/.test(linje.trim()) || /^\d+[.)]\s/.test(linje.trim());
    const renLinje = linje.replace(/^#{1,3}\s*/, "").trim();

    if (erOverskrift) {
      return new Paragraph({
        children: [new TextRun({ text: renLinje, bold: true, size: 24, font: "Arial", color: NAVY })],
        spacing: { before: 160, after: 60 },
      });
    }
    if (erOppgave) {
      return new Paragraph({
        children: [new TextRun({ text: renLinje, size: 22, font: "Arial" })],
        spacing: { before: 80, after: 80 },
        indent: { left: 360 },
      });
    }
    return new Paragraph({
      children: [new TextRun({ text: renLinje, size: 22, font: "Arial" })],
      spacing: { before: 60, after: 60 },
    });
  });

  // ── MUNTLIG ØVELSE ──
  const muntligHeader = new Paragraph({
    children: [new TextRun({ text: "🗣️ Muntlig øvelse", bold: true, size: 26, font: "Arial", color: NAVY })],
    spacing: { before: 280, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 1 } },
  });

  const muntligBoks = new Table({
    width: { size: 9026, type: WidthType.DXA },
    columnWidths: [9026],
    rows: [new TableRow({
      children: [new TableCell({
        borders: noBorders,
        shading: { fill: LIGHT_YELLOW, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 180, right: 180 },
        width: { size: 9026, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: "🗣️  Snakk med en makker (par)", bold: true, size: 22, font: "Arial" })], spacing: { after: 80 } }),
          new Paragraph({ children: [new TextRun({ text: `A: Hva heter du?   B: Jeg heter ___.`, size: 22, font: "Arial" })], spacing: { after: 60 } }),
          new Paragraph({ children: [new TextRun({ text: `A: Hvor kommer du fra?   B: Jeg kommer fra ___.`, size: 22, font: "Arial" })], spacing: { after: 60 } }),
          new Paragraph({ children: [new TextRun({ text: `A: Hvor bor du nå?   B: Jeg bor i ___.`, size: 22, font: "Arial" })], spacing: { after: 40 } }),
        ],
      })],
    })],
  });

  // ── FASIT ──
  const fasitDivider = new Paragraph({
    children: [new TextRun({ text: "─────────────────────────────────────────────────────────", size: 18, color: "AAAAAA", font: "Arial" })],
    spacing: { before: 400, after: 80 },
  });

  const fasitHeader = new Paragraph({
    children: [new TextRun({ text: "FASIT", bold: true, size: 26, font: "Arial", color: "666666" })],
    spacing: { before: 80, after: 80 },
  });

  // Dynamisk fasit fra Gemini
  const fasit = (genData && genData.fasit) ? genData.fasit : null;
  const fasitBarn = [];

  if (fasit) {
    // Fyll inn
    if (fasit.fyll_inn && fasit.fyll_inn.length) {
      fasitBarn.push(new Paragraph({ children: [new TextRun({ text: "Fyll inn:", bold: true, size: 20, font: "Arial", color: NAVY })], spacing: { before: 80, after: 40 } }));
      fasit.fyll_inn.forEach((svar, i) => {
        fasitBarn.push(new Paragraph({ children: [new TextRun({ text: `${String.fromCharCode(97+i)})  ${svar}`, size: 20, font: "Arial" })], spacing: { after: 20 } }));
      });
    }
    // Sant / usant
    if (fasit.sant_usant && fasit.sant_usant.length) {
      fasitBarn.push(new Paragraph({ children: [new TextRun({ text: "Sant / usant:", bold: true, size: 20, font: "Arial", color: NAVY })], spacing: { before: 120, after: 40 } }));
      fasit.sant_usant.forEach((riktig, i) => {
        fasitBarn.push(new Paragraph({ children: [new TextRun({ text: `${i+1}.  ${riktig ? "SANT ✓" : "USANT ✗"}`, size: 20, font: "Arial" })], spacing: { after: 20 } }));
      });
    }
    // Ordstilling
    if (fasit.ordstilling && fasit.ordstilling.length) {
      fasitBarn.push(new Paragraph({ children: [new TextRun({ text: "Ordstilling:", bold: true, size: 20, font: "Arial", color: NAVY })], spacing: { before: 120, after: 40 } }));
      fasit.ordstilling.forEach((setning, i) => {
        fasitBarn.push(new Paragraph({ children: [new TextRun({ text: `${i+1}.  ${setning}`, size: 20, font: "Arial" })], spacing: { after: 20 } }));
      });
    }
    // Flervalg forklaring
    if (fasit.mc_forklaring && fasit.mc_forklaring.length) {
      fasitBarn.push(new Paragraph({ children: [new TextRun({ text: "Flervalg – forklaringer:", bold: true, size: 20, font: "Arial", color: NAVY })], spacing: { before: 120, after: 40 } }));
      fasit.mc_forklaring.forEach((forkl, i) => {
        fasitBarn.push(new Paragraph({ children: [new TextRun({ text: `${i+1}.  ${forkl}`, size: 20, font: "Arial" })], spacing: { after: 20 } }));
      });
    }
  } else {
    fasitBarn.push(new Paragraph({ children: [new TextRun({ text: "Fasit genereres automatisk neste gang du laster ned Word-filen etter å ha klikket Generer.", size: 20, italics: true, font: "Arial", color: "666666" })] }));
  }

  const fasitBoks = new Table({
    width: { size: 9026, type: WidthType.DXA }, columnWidths: [9026],
    rows: [new TableRow({ children: [new TableCell({
      borders: noBorders,
      shading: { fill: LIGHT_GREY, type: ShadingType.CLEAR },
      margins: { top: 120, bottom: 120, left: 180, right: 180 },
      width: { size: 9026, type: WidthType.DXA },
      children: fasitBarn,
    })] })],
  });

  // ── BYGG DOKUMENT ──
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children: [
        topptekst,
        new Paragraph({ children: [], spacing: { after: 120 } }),
        laringsmaalHeader,
        laringsmaalBoks,
        new Paragraph({ children: [], spacing: { after: 80 } }),
        ordlisteHeader,
        ordliste,
        new Paragraph({ children: [], spacing: { after: 80 } }),
        ...(bildeParagrafer.length ? [...bildeParagrafer, new Paragraph({ children: [], spacing: { after: 80 } })] : []),
        innholdHeader,
        ...innholdParagrafer,
        new Paragraph({ children: [], spacing: { after: 80 } }),
        muntligHeader,
        muntligBoks,
        fasitDivider,
        fasitHeader,
        fasitBoks,
      ],
    }],
  });

  return await Packer.toBuffer(doc);
}

// ── PPTX-GENERERING ──────────────────────────────────
async function genererPPTX({ kap, tittel, innhold, grammatikk, oppgaver }) {
  const pptxgen = require("pptxgenjs");
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";

  const C = {
    navy: "1B3A5C", gold: "C9960C", white: "FFFFFF",
    offwhite: "F7F4EE", text: "1A1A2E", muted: "6B7B8D",
    light: "E8EDF2", goldLight: "E8C050"
  };

  const assetsDir = path.join(__dirname, "public/assets");
  const logoMoved   = fs.readFileSync(path.join(assetsDir, "logo_moved.png")).toString("base64");
  const logoKommune = fs.readFileSync(path.join(assetsDir, "logo_kommune.png")).toString("base64");
  const fjordBanner = fs.readFileSync(path.join(assetsDir, "fjord_banner.png")).toString("base64");

  const logoMovedData   = `image/png;base64,${logoMoved}`;
  const logoKommuneData = `image/png;base64,${logoKommune}`;
  const fjordData       = `image/png;base64,${fjordBanner}`;
  const kapNavn = `Kapittel ${kap.id} – ${kap.tittel}`;

  // ── HJELPEFUNKSJONER ──────────────────────────────────────────────────────

  // Én MOVED-logo øverst til høyre, alltid hvit bakgrunn for god kontrast
  function addLogo(slide) {
    slide.addShape("rect", {
      x: 8.0, y: 0.12, w: 1.85, h: 0.78,
      fill: { color: C.white }, line: { color: C.white }
    });
    slide.addImage({ data: logoMovedData, x: 8.08, y: 0.20, w: 1.68, h: 0.58, altText: "MOVED" });
  }

  // Footer med fjordbilde + Molde Kommune-logo (UTEN MOVED-logo)
  function addFooter(slide) {
    slide.addImage({ data: fjordData, x: 0, y: 4.68, w: 10, h: 1.0, altText: "Molde fjord" });
    slide.addShape("rect", { x: 0, y: 5.35, w: 10, h: 0.275, fill: { color: C.navy }, line: { color: C.navy } });
    slide.addImage({ data: logoKommuneData, x: 0.25, y: 4.77, w: 1.3, h: 0.42, altText: "Molde Kommune" });
    slide.addText(kapNavn, { x: 3.5, y: 4.78, w: 3, h: 0.3, fontSize: 9, color: C.muted, fontFace: "Calibri", align: "center", margin: 0 });
  }

  // ── SLIDE 1: FORSIDE ─────────────────────────────────────────────────────
  const s1 = pres.addSlide();
  s1.background = { color: C.white };
  // Venstre navy-søyle
  s1.addShape("rect", { x: 0, y: 0, w: 3.8, h: 5.625, fill: { color: C.navy }, line: { color: C.navy } });
  s1.addShape("rect", { x: 3.55, y: 0, w: 0.25, h: 5.625, fill: { color: C.gold }, line: { color: C.gold } });
  // Kapittelinfo i sidebar
  s1.addShape("rect", { x: 0.3, y: 1.05, w: 3.0, h: 0.035, fill: { color: C.goldLight }, line: { color: C.goldLight } });
  s1.addText(kapNavn.toUpperCase(), { x: 0.3, y: 1.2, w: 3.1, h: 0.35, fontSize: 8, color: C.goldLight, fontFace: "Calibri", bold: true, charSpacing: 2, margin: 0 });
  s1.addImage({ data: fjordData, x: 0, y: 4.3, w: 3.8, h: 0.62, altText: "Molde fjord" });
  // Tittel-seksjon
  s1.addText(tittel || kap.tittel, { x: 4.1, y: 1.0, w: 5.6, h: 2.2, fontSize: 34, color: C.navy, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  s1.addShape("rect", { x: 4.1, y: 3.3, w: 2.4, h: 0.07, fill: { color: C.gold }, line: { color: C.gold } });
  s1.addText(`CEFR A1  ·  ${kap.funksjoner[0]}`, { x: 4.1, y: 3.5, w: 5.5, h: 0.5, fontSize: 13, color: C.muted, fontFace: "Calibri", italic: true, align: "left", margin: 0 });
  // Molde Kommune-logo nede til høyre
  s1.addImage({ data: logoKommuneData, x: 7.8, y: 5.1, w: 1.9, h: 0.45, altText: "Molde Kommune" });
  // MOVED-logo øverst til høyre – hvit bakgrunn
  addLogo(s1);

  // ── SLIDE 2: LÆRINGSMÅL ──────────────────────────────────────────────────
  const s2 = pres.addSlide();
  s2.background = { color: C.white };
  s2.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
  s2.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s2.addText("🎯 Læringsmål", { x: 0.45, y: 0.05, w: 7.5, h: 0.95, fontSize: 22, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  const mal = ["Jeg kan hilse og presentere meg på norsk.", "Jeg kan si hvor jeg kommer fra og hvor jeg bor.", "Jeg kjenner til V2-regelen.", "Jeg kan spørre: Hva heter du? Hvor kommer du fra?"];
  const malItems = mal.map(m => ({ text: m, options: { bullet: { color: C.gold }, breakLine: true, color: C.text, fontSize: 16, fontFace: "Calibri", paraSpaceAfter: 10 } }));
  s2.addText(malItems, { x: 0.8, y: 1.3, w: 8.5, h: 3.2, valign: "top", margin: 8 });
  addLogo(s2);
  addFooter(s2);

  // ── SLIDE 3: INNHOLD ─────────────────────────────────────────────────────
  const s3 = pres.addSlide();
  s3.background = { color: C.white };
  s3.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
  s3.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s3.addText("📖 " + kap.tittel, { x: 0.45, y: 0.05, w: 7.5, h: 0.95, fontSize: 20, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  if (innhold) {
    const linjer = innhold.split("\n").filter(l => l.trim()).slice(0, 6);
    const items = linjer.map(l => ({ text: l, options: { bullet: { color: C.gold }, breakLine: true, color: C.text, fontSize: 14, fontFace: "Calibri", paraSpaceAfter: 6 } }));
    s3.addText(items, { x: 0.5, y: 1.2, w: 9, h: 3.3, valign: "top", margin: 8 });
  }
  addLogo(s3);
  addFooter(s3);

  // ── SLIDE 4: GRAMMATIKK ──────────────────────────────────────────────────
  if (kap.grammatikk.length > 0) {
    const s4 = pres.addSlide();
    s4.background = { color: C.white };
    s4.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
    s4.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
    s4.addText("📚 Grammatikk", { x: 0.45, y: 0.05, w: 3.0, h: 0.95, fontSize: 12, color: C.goldLight, fontFace: "Calibri", bold: true, align: "left", valign: "middle", charSpacing: 1, margin: 0 });
    s4.addText(kap.grammatikk[0] || "Grammatikk", { x: 3.3, y: 0.05, w: 5.0, h: 0.95, fontSize: 18, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "center", valign: "middle", margin: 0 });
    // Regel-kort
    s4.addShape("rect", { x: 0.3, y: 1.25, w: 4.5, h: 2.8, fill: { color: C.white }, line: { color: C.light, pt: 1.5 }, shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.12 } });
    s4.addShape("rect", { x: 0.3, y: 1.25, w: 0.18, h: 2.8, fill: { color: C.navy }, line: { color: C.navy } });
    s4.addText("Regel", { x: 0.6, y: 1.35, w: 4.0, h: 0.4, fontSize: 13, color: C.navy, fontFace: "Trebuchet MS", bold: true, margin: 0 });
    s4.addText(grammatikk || `${kap.grammatikk[0]}:\n\nI norske setninger er verbet alltid på andre plass.\nDette kalles V2-regelen.`, { x: 0.6, y: 1.8, w: 3.95, h: 2.1, fontSize: 13, color: C.text, fontFace: "Calibri", valign: "top", margin: 4, wrap: true });
    // Eksempel-kort
    s4.addShape("rect", { x: 5.2, y: 1.25, w: 4.5, h: 2.8, fill: { color: C.navy }, line: { color: C.navy }, shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.12 } });
    s4.addShape("rect", { x: 5.2, y: 1.25, w: 0.18, h: 2.8, fill: { color: C.gold }, line: { color: C.gold } });
    s4.addText("Eksempler", { x: 5.5, y: 1.35, w: 3.9, h: 0.4, fontSize: 13, color: C.goldLight, fontFace: "Trebuchet MS", bold: true, margin: 0 });
    const exListe = kap.ordliste.slice(0, 4).map(o => ({ text: `Jeg ${o}... `, options: { bullet: { color: C.gold }, breakLine: true, color: C.white, fontSize: 13, fontFace: "Calibri", paraSpaceAfter: 8 } }));
    s4.addText(exListe, { x: 5.5, y: 1.8, w: 3.9, h: 2.1, valign: "top", margin: 4 });
    addLogo(s4);
    addFooter(s4);
  }

  // ── SLIDE 5: OPPGAVER ────────────────────────────────────────────────────
  const s5 = pres.addSlide();
  s5.background = { color: C.offwhite };
  s5.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
  s5.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s5.addText("✏️ Oppgaver", { x: 0.45, y: 0.05, w: 3.0, h: 0.95, fontSize: 13, color: C.goldLight, fontFace: "Calibri", bold: true, align: "left", valign: "middle", charSpacing: 1, margin: 0 });
  s5.addText("Øvingsoppgaver", { x: 3.3, y: 0.05, w: 5.3, h: 0.95, fontSize: 20, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  s5.addShape("rect", { x: 8.6, y: 0.0, w: 1.4, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s5.addText("A1", { x: 8.6, y: 0.0, w: 1.4, h: 1.05, fontSize: 28, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "center", valign: "middle", margin: 0 });
  const oppgaveListe = oppgaver || [
    "Hva heter du? Snakk med makkeren din.",
    "Sett inn riktig verb: Jeg ___ norsk. (snakke)",
    "Skriv tre setninger om deg selv.",
    "Fyll inn: Hun ___ fra Polen. (komme)",
    "Sorter ordene: bor / jeg / Oslo / i",
    "Riktig eller feil? «Han heter Oslo.»"
  ];
  const colW = 4.4, rowH = 1.05, gap = 0.2;
  oppgaveListe.slice(0, 6).forEach((opp, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.35 + col * (colW + gap), y = 1.25 + row * (rowH + 0.15);
    const letter = String.fromCharCode(97 + i);
    s5.addShape("rect", { x, y, w: colW, h: rowH, fill: { color: C.white }, line: { color: C.light, pt: 1 }, shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.12 } });
    s5.addShape("rect", { x, y, w: 0.42, h: rowH, fill: { color: C.navy }, line: { color: C.navy } });
    s5.addText(letter, { x, y, w: 0.42, h: rowH, fontSize: 16, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "center", valign: "middle", margin: 0 });
    s5.addText(opp, { x: x + 0.52, y: y + 0.08, w: colW - 0.62, h: rowH - 0.16, fontSize: 12, color: C.text, fontFace: "Calibri", valign: "middle", margin: 4, wrap: true });
  });
  addLogo(s5);
  addFooter(s5);

  return await pres.write({ outputType: "nodebuffer" });
}


// ── START ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Norsk A1-portalen kjører på http://localhost:${PORT}`);
});

module.exports = app;
