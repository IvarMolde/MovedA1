# MOVED – Norsk A1-portal

Profesjonell lærerportal for Molde voksenopplæringssenter.  
Genererer undervisningsmateriell (tekst, PPTX) via Gemini 2.5 Flash.

---

## Filstruktur

```
norsk-a1-portal/
├── server.js              ← Hovedserver (Express)
├── vercel.json            ← Vercel deployment-konfig
├── package.json
├── .env.example           ← Kopier til .env og fyll inn
├── data/
│   └── kapitler.json      ← Alle 15 kapitler fra God i norsk
└── public/
    ├── login.html          ← Innloggingsside
    ├── index.html          ← Forsiden (kapitteloversikt)
    ├── kapittel.html       ← Kapittelsiden + AI-generator
    ├── grammatikk.html     ← Søkbar grammatikkbank
    ├── norsk_a1_oppgaver.html ← Digitale oppgaver (8 typer)
    └── assets/
        ├── logo_moved.png
        ├── logo_kommune.png
        └── fjord_banner.png
```

---

## Lokal oppsett

```bash
# 1. Installer avhengigheter
npm install

# 2. Sett opp miljøvariabler
cp .env.example .env
# Fyll inn APP_PASSORD, GOOGLE_API_KEY, SESSION_SECRET i .env

# 3. Start serveren
npm run dev
# → http://localhost:3000
```

---

## Deploy til Vercel

```bash
# Installer Vercel CLI (én gang)
npm install -g vercel

# Logg inn
vercel login

# Deploy (første gang)
vercel

# Sett miljøvariabler i Vercel
vercel env add APP_PASSORD
vercel env add GOOGLE_API_KEY
vercel env add SESSION_SECRET

# Redeploy med nye variabler
vercel --prod
```

### Alternativt via Vercel dashboard:
1. Push kode til GitHub
2. Koble GitHub-repo til Vercel
3. Legg til miljøvariabler under **Settings → Environment Variables**
4. Deploy automatisk ved push til `main`

---

## Google Cloud API-nøkkel

1. Gå til [console.cloud.google.com](https://console.cloud.google.com)
2. Velg eller opprett et prosjekt
3. Gå til **APIs & Services → Enabled APIs**
4. Aktiver **Generative Language API** (Gemini)
5. Gå til **Credentials → Create Credentials → API Key**
6. Kopier nøkkelen og lim inn som `GOOGLE_API_KEY` i `.env` / Vercel

---

## Miljøvariabler

| Variabel | Beskrivelse | Eksempel |
|----------|-------------|---------|
| `APP_PASSORD` | Passord for å logge inn | `NorskA1_2025!` |
| `GOOGLE_API_KEY` | Google Cloud API-nøkkel med Gemini aktivert | `AIzaSy...` |
| `SESSION_SECRET` | Tilfeldig hemmelig streng (min. 32 tegn) | `abc123...xyz` |

---

## Funksjonalitet

### Innlogging
- Enkel passordbasert innlogging (samme mønster som Kantineportalen og Yrkesappen)
- Session holdes aktiv i 8 timer
- Viderekobles til `/login` hvis ikke innlogget

### Forsiden
- Oversikt over alle 15 kapitler fra *God i norsk*
- Filtrer på A1-fokus, grammatikk eller yrkestekst
- Klikk på et kapittel for å gå til generatoren

### Kapittelsiden
- Venstre kolonne: Leksjoner (1.1–1.5), Grammatikk, Nøkkelord
- AI-generator: Velg type (lesetekst, arbeidsark, grammatikk, samtale, yrkestekst)
- Streaming fra Gemini – tekst vises i sanntid
- Last ned som PPTX med MOVED-design
- Kopier tekst til utklipstavle
- Digitale oppgaver (8 typer) i ny fane

### Grammatikkbank
- Flat søkbar oversikt over alle grammatikkemner
- Direktelenke til riktig kapittel

---

## MOVED Designsystem

| Element | Verdi |
|---------|-------|
| Primærfarge (Navy) | `#1B3A5C` |
| Aksent (Gull) | `#C9960C` |
| Bakgrunn | `#F7F4EE` |
| Tittelskrift | Syne (Google Fonts) |
| Brødtekst | DM Sans (Google Fonts) |
| PPTX-tittelskrift | Trebuchet MS |
| PPTX-brødtekst | Calibri |

Logoer, fjordillustrasjon og Molde Kommune-logo brukes på alle sider og i alle PPTX-filer.

---

## Legge til oppgave-HTML

Kopier `norsk_a1_oppgaver.html` (allerede laget med 8 oppgavetyper) inn i `public/`-mappen.  
Kapittelsiden lenker automatisk til den.

---

## Utvide portalen

### Legge til ny oppgavetype i generatoren
Legg til i `typeInstruksjon`-objektet i `server.js`:
```javascript
nyType: `Lag en [beskriv type] for kapittelet...`
```

### Legge til nytt kapittel / justere innhold
Rediger `data/kapitler.json` – alle sider bruker denne filen automatisk.

### Endre PPTX-design
Se `genererPPTX()`-funksjonen i `server.js`. Alle farger og layouts kan justeres der.

---

## Teknisk stack

- **Runtime:** Node.js 18+
- **Server:** Express.js
- **Auth:** express-session (passord-basert, som andre MBO-apper)
- **AI:** Google Generative AI SDK → Gemini 2.5 Flash
- **PPTX:** pptxgenjs
- **DOCX:** docx (klar for fremtidig arbeidsark-nedlasting)
- **Deploy:** Vercel (serverless)
- **Fonter:** Google Fonts (Syne + DM Sans)
