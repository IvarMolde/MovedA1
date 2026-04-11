require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "norsk-a1-portal-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// ── AUTH MIDDLEWARE ───────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  res.redirect("/login");
}

// ── DATA ─────────────────────────────────────────────
let kapitler = [];
try {
  const dataPath = path.join(__dirname, "data/kapitler.json");
  kapitler = JSON.parse(fs.readFileSync(dataPath, "utf8"));
} catch (e) {
  try {
    const dataPath2 = path.join(process.cwd(), "data/kapitler.json");
    kapitler = JSON.parse(fs.readFileSync(dataPath2, "utf8"));
  } catch (e2) {
    console.error("Kunne ikke laste kapitler.json:", e2.message);
  }
}

// ── ROUTES: AUTH ──────────────────────────────────────
app.get("/login", (req, res) => {
  if (req.session?.loggedIn) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public/login.html"));
});

app.post("/login", (req, res) => {
  const { passord } = req.body;
  if (passord === process.env.APP_PASSORD) {
    req.session.loggedIn = true;
    req.session.loginTime = Date.now();
    res.redirect("/");
  } else {
    res.redirect("/login?feil=1");
  }
});

app.get("/logg-ut", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ── ROUTES: SIDER ────────────────────────────────────
app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/kapittel/:id", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/kapittel.html"));
});

app.get("/grammatikk", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/grammatikk.html"));
});

// ── API: KAPITLER ─────────────────────────────────────
app.get("/api/kapitler", requireAuth, (req, res) => {
  res.json(kapitler);
});

app.get("/api/kapitler/:id", requireAuth, (req, res) => {
  const kap = kapitler.find(k => k.id === parseInt(req.params.id));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });
  res.json(kap);
});

// ── API: GENERER INNHOLD ──────────────────────────────
app.post("/api/generer", requireAuth, async (req, res) => {
  const { kapittelId, leksjon, type, yrke, nivaa = "A1" } = req.body;

  if (!kapittelId || !type) {
    return res.status(400).json({ error: "Mangler kapittelId eller type" });
  }

  const kap = kapitler.find(k => k.id === parseInt(kapittelId));
  if (!kap) return res.status(404).json({ error: "Kapittel ikke funnet" });

  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = byggPrompt({ kap, leksjon, type, yrke, nivaa });

    // Streaming-respons
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
    if (!res.headersSent) {
      res.status(500).json({ error: "Generering feilet. Prøv igjen." });
    }
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
app.get("/api/helse", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── PROMPT-BYGGER ────────────────────────────────────
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
    yrkestekst: `Lag en yrkestekst om ${yrke || kap.yrke} som bruker ord og situasjoner fra kapittelet. Inkluder: 1) En kort presentasjonstekst (60 ord, jeg-form), 2) 5 yrkesspesifikke ord med forklaring, 3) Tre oppgaver knyttet til yrkeskontekst (a–c).`,
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

// ── PPTX-GENERERING ──────────────────────────────────
async function genererPPTX({ kap, tittel, innhold, grammatikk, oppgaver }) {
  const pptxgen = require("pptxgenjs");
  const fs = require("fs");
  const path = require("path");

  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";

  const C = {
    navy: "1B3A5C", gold: "C9960C", white: "FFFFFF",
    offwhite: "F7F4EE", text: "1A1A2E", muted: "6B7B8D",
    light: "E8EDF2", goldLight: "E8C050"
  };

  const assetsDir = path.join(__dirname, "public/assets");
  const logoMoved = fs.readFileSync(path.join(assetsDir, "logo_moved.png")).toString("base64");
  const logoKommune = fs.readFileSync(path.join(assetsDir, "logo_kommune.png")).toString("base64");
  const fjordBanner = fs.readFileSync(path.join(assetsDir, "fjord_banner.png")).toString("base64");

  const logoMovedData = `image/png;base64,${logoMoved}`;
  const logoKommuneData = `image/png;base64,${logoKommune}`;
  const fjordData = `image/png;base64,${fjordBanner}`;

  const kapNavn = `Kapittel ${kap.id} – ${kap.tittel}`;

  function addFooter(slide) {
    slide.addImage({ data: fjordData, x: 0, y: 4.68, w: 10, h: 1.0, altText: "Molde fjord" });
    slide.addShape("rect", { x: 0, y: 5.35, w: 10, h: 0.275, fill: { color: C.navy }, line: { color: C.navy } });
    slide.addImage({ data: logoMovedData, x: 7.8, y: 4.72, w: 1.8, h: 0.51, altText: "MOVED" });
    slide.addImage({ data: logoKommuneData, x: 0.25, y: 4.77, w: 1.3, h: 0.42, altText: "Molde Kommune" });
    slide.addText(kapNavn, { x: 3.5, y: 4.78, w: 3, h: 0.3, fontSize: 9, color: C.muted, fontFace: "Calibri", align: "center", margin: 0 });
  }

  // SLIDE 1: FORSIDE
  const s1 = pres.addSlide();
  s1.background = { color: C.white };
  s1.addShape("rect", { x: 0, y: 0, w: 3.8, h: 5.625, fill: { color: C.navy }, line: { color: C.navy } });
  s1.addShape("rect", { x: 3.55, y: 0, w: 0.25, h: 5.625, fill: { color: C.gold }, line: { color: C.gold } });
  s1.addImage({ data: logoMovedData, x: 0.25, y: 0.28, w: 2.2, h: 0.62, altText: "MOVED" });
  s1.addShape("rect", { x: 0.3, y: 1.05, w: 3.0, h: 0.035, fill: { color: C.goldLight }, line: { color: C.goldLight } });
  s1.addText(kapNavn.toUpperCase(), { x: 0.3, y: 1.2, w: 3.1, h: 0.35, fontSize: 8, color: C.goldLight, fontFace: "Calibri", bold: true, charSpacing: 2, margin: 0 });
  s1.addImage({ data: fjordData, x: 0, y: 4.3, w: 3.8, h: 0.62, altText: "Molde fjord" });
  s1.addText(tittel || kap.tittel, { x: 4.1, y: 1.0, w: 5.6, h: 2.2, fontSize: 34, color: C.navy, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  s1.addShape("rect", { x: 4.1, y: 3.3, w: 2.4, h: 0.07, fill: { color: C.gold }, line: { color: C.gold } });
  s1.addText(`CEFR ${kap.id <= 6 ? "A1" : kap.id <= 10 ? "A1–A2" : "A2"}  ·  ${kap.funksjoner[0]}`, { x: 4.1, y: 3.5, w: 5.5, h: 0.5, fontSize: 13, color: C.muted, fontFace: "Calibri", italic: true, align: "left", margin: 0 });
  s1.addImage({ data: logoKommuneData, x: 7.8, y: 5.1, w: 1.9, h: 0.62, altText: "Molde Kommune" });

  // SLIDE 2: LÆRINGSMÅL
  const s2 = pres.addSlide();
  s2.background = { color: C.white };
  s2.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
  s2.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s2.addText("🎯 Læringsmål", { x: 0.45, y: 0.05, w: 7.5, h: 0.95, fontSize: 22, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  s2.addImage({ data: logoMovedData, x: 8.2, y: 0.25, w: 1.55, h: 0.44, altText: "MOVED" });
  const mal = ["Jeg kan hilse og presentere meg på norsk.", "Jeg kan si hvor jeg kommer fra og hvor jeg bor.", "Jeg kjenner til V2-regelen.", "Jeg kan spørre: Hva heter du? Hvor kommer du fra?"];
  const malItems = mal.map(m => ({ text: m, options: { bullet: { color: C.gold }, breakLine: true, color: C.text, fontSize: 16, fontFace: "Calibri", paraSpaceAfter: 10 } }));
  s2.addText(malItems, { x: 0.8, y: 1.3, w: 8.5, h: 3.2, valign: "top", margin: 8 });
  addFooter(s2);

  // SLIDE 3: INNHOLD
  const s3 = pres.addSlide();
  s3.background = { color: C.white };
  s3.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
  s3.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
  s3.addText("📖 " + kap.tittel, { x: 0.45, y: 0.05, w: 7.5, h: 0.95, fontSize: 20, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "left", valign: "middle", margin: 0 });
  s3.addImage({ data: logoMovedData, x: 8.2, y: 0.25, w: 1.55, h: 0.44, altText: "MOVED" });
  if (innhold) {
    const linjer = innhold.split("\n").filter(l => l.trim()).slice(0, 6);
    const items = linjer.map(l => ({ text: l, options: { bullet: { color: C.gold }, breakLine: true, color: C.text, fontSize: 14, fontFace: "Calibri", paraSpaceAfter: 6 } }));
    s3.addText(items, { x: 0.5, y: 1.2, w: 9, h: 3.3, valign: "top", margin: 8 });
  }
  addFooter(s3);

  // SLIDE 4: GRAMMATIKK
  if (kap.grammatikk.length > 0) {
    const s4 = pres.addSlide();
    s4.background = { color: C.white };
    s4.addShape("rect", { x: 0, y: 0, w: 10, h: 1.05, fill: { color: C.navy }, line: { color: C.navy } });
    s4.addShape("rect", { x: 0, y: 0, w: 0.22, h: 1.05, fill: { color: C.gold }, line: { color: C.gold } });
    s4.addText("📚 Grammatikk", { x: 0.45, y: 0.05, w: 3.0, h: 0.95, fontSize: 12, color: C.goldLight, fontFace: "Calibri", bold: true, align: "left", valign: "middle", charSpacing: 1, margin: 0 });
    s4.addText(kap.grammatikk[0] || "Grammatikk", { x: 3.3, y: 0.05, w: 5.0, h: 0.95, fontSize: 18, color: C.white, fontFace: "Trebuchet MS", bold: true, align: "center", valign: "middle", margin: 0 });
    s4.addImage({ data: logoMovedData, x: 8.2, y: 0.25, w: 1.55, h: 0.44, altText: "MOVED" });
    s4.addShape("rect", { x: 0.3, y: 1.25, w: 4.5, h: 2.8, fill: { color: C.white }, line: { color: C.light, pt: 1.5 }, shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.12 } });
    s4.addShape("rect", { x: 0.3, y: 1.25, w: 0.18, h: 2.8, fill: { color: C.navy }, line: { color: C.navy } });
    s4.addText("Regel", { x: 0.6, y: 1.35, w: 4.0, h: 0.4, fontSize: 13, color: C.navy, fontFace: "Trebuchet MS", bold: true, margin: 0 });
    s4.addText(grammatikk || `${kap.grammatikk[0]}:\n\nI norske setninger er verbet alltid på andre plass.\nDette kalles V2-regelen.`, { x: 0.6, y: 1.8, w: 3.95, h: 2.1, fontSize: 13, color: C.text, fontFace: "Calibri", valign: "top", margin: 4, wrap: true });
    s4.addShape("rect", { x: 5.2, y: 1.25, w: 4.5, h: 2.8, fill: { color: C.navy }, line: { color: C.navy }, shadow: { type: "outer", blur: 8, offset: 3, angle: 135, color: "000000", opacity: 0.12 } });
    s4.addShape("rect", { x: 5.2, y: 1.25, w: 0.18, h: 2.8, fill: { color: C.gold }, line: { color: C.gold } });
    s4.addText("Eksempler", { x: 5.5, y: 1.35, w: 3.9, h: 0.4, fontSize: 13, color: C.goldLight, fontFace: "Trebuchet MS", bold: true, margin: 0 });
    const exListe = kap.ordliste.slice(0, 4).map(o => ({ text: `Jeg ${o}... `, options: { bullet: { color: C.gold }, breakLine: true, color: C.white, fontSize: 13, fontFace: "Calibri", paraSpaceAfter: 8 } }));
    s4.addText(exListe, { x: 5.5, y: 1.8, w: 3.9, h: 2.1, valign: "top", margin: 4 });
    addFooter(s4);
  }

  // SLIDE 5: OPPGAVER
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
  addFooter(s5);

  const buf = await pres.write({ outputType: "nodebuffer" });
  return buf;
}

// ── START ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Norsk A1-portalen kjører på http://localhost:${PORT}`);
});

module.exports = app;
