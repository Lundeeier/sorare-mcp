# Sorare Market MCP

En liten server som lar Claude søke i Sorares offentlige marked: finne spillere
og se de billigste kortene som er til salgs. Ingen innlogging.

Dette er STEG 1 (kun marked). Galleriet ditt (innlogging) kommer som steg 2.

---

## Hva du trenger
- En gratis GitHub-konto (github.com)
- En gratis Render-konto (render.com) – logg inn med GitHub
- Claude Pro/Max (custom connectors krever betalt plan)

Du trenger IKKE å kunne kode. Du laster bare opp filer og trykker på knapper.

---

## Del A – Legg filene på GitHub

1. Gå til github.com, logg inn, klikk **+** oppe til høyre → **New repository**.
2. Navn: `sorare-mcp`. Sett den til **Public**. Klikk **Create repository**.
3. På den nye siden: klikk **uploading an existing file**.
4. Dra inn disse fire filene fra denne mappen:
   - `package.json`
   - `server.js`
   - `render.yaml`
   - `README.md`
5. Klikk **Commit changes**.

---

## Del B – Deploy på Render

1. Gå til render.com → **New** → **Web Service**.
2. Velg **Build and deploy from a Git repository** → koble til GitHub → velg `sorare-mcp`.
3. Render leser `render.yaml` automatisk. Bekreft:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: **Free**
4. Klikk **Create Web Service**. Vent 1–3 min til statusen er **Live**.
5. Kopier URL-en øverst, f.eks. `https://sorare-mcp-xxxx.onrender.com`.

Test at den lever: åpne URL-en i nettleseren. Du skal se teksten
"Sorare Market MCP is running. POST /mcp".

---

## Del C – Koble til Claude

1. Åpne Claude → **Settings** → **Connectors**.
2. Klikk **Add custom connector**.
3. Lim inn URL-en din PLUSS `/mcp` på slutten:
   `https://sorare-mcp-xxxx.onrender.com/mcp`
4. Klikk **Add**, deretter **Connect**.
5. Start en ny chat. I **+**-menyen: skru på connectoren for samtalen.
6. Test: skriv "søk etter spilleren Meerdink i Sorare".

---

## Viktig å vite

- **Gratis-Render sovner** etter ~15 min uten trafikk. Første kall etter det tar
  ~30–60 sek, og kan gi en "connection error" – bare prøv igjen én gang.
- **Rate limit:** offentlig API tåler ~20 kall/min. Vil du ha mer, be Sorare om
  en API-nøkkel (help.sorare.com, "Reason: API") og legg den inn på Render som
  miljøvariabelen `SORARE_API_KEY`.
- **Hvis et søk feiler** med "unknown field": Sorare har endret API-et. Bruk
  verktøyet `sorare_get_schema` (Claude kan kalle det) for å hente gjeldende
  feltnavn, så fikser vi spørringen.

## Verktøy serveren gir Claude
- `sorare_search_players` – finn spiller på navn
- `sorare_player_market` – billigste kort til salgs for en spiller
- `sorare_graphql` – kjør hvilken som helst spørring (reserveløsning)
- `sorare_get_schema` – hent gjeldende skjema for feilsøking
