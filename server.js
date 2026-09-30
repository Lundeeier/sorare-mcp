// Sorare Market MCP server (remote, Streamable HTTP)
// -------------------------------------------------
// Exposes the PUBLIC Sorare football GraphQL API as MCP tools so Claude can
// search players and look up the cheapest cards on the market.
//
// No login required. Public API is rate limited to ~20 calls/min.
//
// Tools:
//   1. sorare_search_players  - find players by name (slug, position, club)
//   2. sorare_player_market   - cheapest cards on sale for a player, by rarity
//   3. sorare_graphql         - run ANY GraphQL query (safety net if a field changed)
//   4. sorare_get_schema      - download the current GraphQL schema text
//
// If tool 1 or 2 ever returns a GraphQL error about an unknown field, run
// sorare_get_schema, send Claude the relevant part, and the query gets fixed.

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SORARE_GQL = "https://api.sorare.com/graphql";
const SORARE_SCHEMA = "https://api.sorare.com/graphql/schema";

// Optional: if you request a private API key from Sorare (help.sorare.com),
// set it as an env var SORARE_API_KEY on Render to raise rate limits.
const API_KEY = process.env.SORARE_API_KEY || null;

async function sorareQuery(query, variables = {}) {
  const headers = { "content-type": "application/json" };
  if (API_KEY) headers["APIKEY"] = API_KEY;
  const res = await fetch(SORARE_GQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (json.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

function textResult(obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text: body }] };
}

function buildServer() {
  const server = new McpServer({ name: "sorare-market", version: "1.0.0" });

  // 1. Search players by name -------------------------------------------------
  // NOTE: field name for player search may change. If this errors, use
  // sorare_graphql / sorare_get_schema to find the current field.
  server.tool(
    "sorare_search_players",
    "Search Sorare football players by name. Returns slug, position and current club.",
    { name: z.string().describe("Player name to search, e.g. 'Meerdink'") },
    async ({ name }) => {
      // Primary: football.players(search:). Fallback: anyPlayer(slug:) if the
      // caller passed something slug-like.
      const searchQuery = `
        query Search($q: String!) {
          football {
            players(search: $q, first: 8) {
              nodes {
                slug
                displayName
                position
                activeClub { name }
              }
            }
          }
        }`;
      try {
        const data = await sorareQuery(searchQuery, { q: name });
        return textResult(data);
      } catch (e) {
        // Fallback: treat the input as a slug guess and try anyPlayer.
        const slugGuess = name.trim().toLowerCase().replace(/\s+/g, "-");
        const fallback = `
          query BySlug($slug: String!) {
            anyPlayer(slug: $slug) {
              slug
              displayName
              ... on Player { position activeClub { name } }
            }
          }`;
        try {
          const data = await sorareQuery(fallback, { slug: slugGuess });
          if (data && data.anyPlayer) return textResult(data);
        } catch (_) {
          /* ignore, fall through to error below */
        }
        return textResult(
          `Search failed: ${e.message}\n\n` +
            `Tried slug '${slugGuess}' as a fallback with no result. ` +
            `Run sorare_get_schema (filter 'players' or 'Search') to find the current field.`
        );
      }
    }
  );

  // 2. Cheapest cards on the market for a player ------------------------------
  // Uses the CURRENT schema: anyPlayer(slug:) for the player, and
  // tokens.liveSingleSaleOffers(playerSlug:) for cards currently on sale.
  // Defaults to Limited only, cheapest first, top 5.
  server.tool(
    "sorare_player_market",
    "For a given player slug, list the cheapest cards currently for sale (default: Limited only, cheapest first, top 5).",
    {
      slug: z.string().describe("Player slug, e.g. 'mexx-meerdink'"),
      rarity: z
        .enum(["limited", "rare", "super_rare", "unique"])
        .optional()
        .describe("Card rarity to filter by. Defaults to 'limited'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many cheapest offers to return. Defaults to 5."),
    },
    async ({ slug, rarity, limit }) => {
      const rarityArg = (rarity || "limited").toUpperCase();
      const first = limit || 5;
      // Pulls prices AND scores in one query:
      //   L5  = LAST_FIVE_SO5_AVERAGE_SCORE
      //   L10 = LAST_TEN_PLAYED_SO5_AVERAGE_SCORE
      //   L40 = LAST_FORTY_SO5_AVERAGE_SCORE
      // AA is averaged in code from the last 15 games (allAroundScore per game).
      const query = `
        query PlayerMarket($slug: String!) {
          anyPlayer(slug: $slug) {
            displayName
            l5: averageScore(type: LAST_FIVE_SO5_AVERAGE_SCORE)
            l10: averageScore(type: LAST_TEN_PLAYED_SO5_AVERAGE_SCORE)
            l40: averageScore(type: LAST_FORTY_SO5_AVERAGE_SCORE)
            anyGameStats(last: 15) {
              ... on PlayerGameStats {
                allAroundScore
              }
            }
            tokens {
              liveSingleSaleOffers(playerSlug: $slug) {
                startDate
                price { eurCents }
                token {
                  rarity
                  seasonYear
                  serialNumber
                }
              }
            }
          }
        }`;
      try {
        const data = await sorareQuery(query, { slug });
        const player = data && data.anyPlayer;
        if (!player) {
          return textResult(`No player found for slug '${slug}'.`);
        }
        // Average AA over the games that have a value.
        const aaVals = (player.anyGameStats || [])
          .map((g) => (g ? g.allAroundScore : null))
          .filter((v) => v != null);
        const aaAvg =
          aaVals.length > 0
            ? (aaVals.reduce((s, v) => s + v, 0) / aaVals.length).toFixed(1)
            : null;
        const raw =
          (player.tokens && player.tokens.liveSingleSaleOffers) || [];
        // Filter by rarity, sort cheapest first, take top N.
        const offers = raw
          .filter(
            (o) =>
              o.token &&
              String(o.token.rarity).toUpperCase() === rarityArg &&
              o.price &&
              o.price.eurCents != null
          )
          .sort((a, b) => a.price.eurCents - b.price.eurCents)
          .slice(0, first)
          .map((o) => ({
            price_eur: (o.price.eurCents / 100).toFixed(2),
            rarity: o.token.rarity,
            season: o.token.seasonYear,
            serial: o.token.serialNumber,
          }));
        return textResult({
          player: player.displayName,
          scores: {
            L5: player.l5,
            L10: player.l10,
            L40: player.l40,
            AA: aaAvg, // averaged over last 15 games
          },
          rarity: rarityArg,
          cheapest: offers,
          count: offers.length,
        });
      } catch (e) {
        return textResult(
          `Market lookup failed: ${e.message}\n\n` +
            `A field name may have changed. Run sorare_get_schema (filter 'Offer' ` +
            `or 'anyPlayer') and send the result to fix the query.`
        );
      }
    }
  );

  // 3. Raw GraphQL passthrough (always works) --------------------------------
  server.tool(
    "sorare_graphql",
    "Run any GraphQL query against the public Sorare API. Use this when the ready-made tools need adjusting.",
    {
      query: z.string().describe("A GraphQL query string."),
      variables: z.record(z.any()).optional().describe("Optional variables object."),
    },
    async ({ query, variables }) => {
      try {
        const data = await sorareQuery(query, variables || {});
        return textResult(data);
      } catch (e) {
        return textResult(`Query failed: ${e.message}`);
      }
    }
  );

  // 4. Download current schema ------------------------------------------------
  server.tool(
    "sorare_get_schema",
    "Fetch the current Sorare GraphQL schema text (large). Use to find current field names when a query breaks.",
    { filter: z.string().optional().describe("Optional substring to grep for, e.g. 'player' or 'Offer'.") },
    async ({ filter }) => {
      const res = await fetch(SORARE_SCHEMA);
      const schema = await res.text();
      if (filter) {
        const lines = schema
          .split("\n")
          .filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
          .slice(0, 200)
          .join("\n");
        return textResult(lines || `No lines matched '${filter}'.`);
      }
      // Cap size to avoid flooding the context
      return textResult(schema.slice(0, 12000) + "\n...(truncated; use a filter)");
    }
  );

  return server;
}

// ---- HTTP wiring (stateless Streamable HTTP; ideal for remote connectors) ----
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("Sorare Market MCP is running. POST /mcp"));

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e) });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sorare Market MCP listening on ${PORT}`));
