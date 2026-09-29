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
      const query = `
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
        const data = await sorareQuery(query, { q: name });
        return textResult(data);
      } catch (e) {
        return textResult(
          `Search failed: ${e.message}\n\n` +
            `The player-search field may have changed. Try sorare_get_schema, ` +
            `or use sorare_graphql with a query you know works.`
        );
      }
    }
  );

  // 2. Cheapest cards on the market for a player ------------------------------
  server.tool(
    "sorare_player_market",
    "For a given player slug, list the cheapest cards currently for sale, optionally filtered by rarity (limited/rare/super_rare/unique).",
    {
      slug: z.string().describe("Player slug, e.g. 'mexx-meerdink'"),
      rarity: z
        .enum(["limited", "rare", "super_rare", "unique"])
        .optional()
        .describe("Card rarity to filter by. Omit for all."),
    },
    async ({ slug, rarity }) => {
      const rarities = rarity ? `[${rarity}]` : `[limited, rare]`;
      const query = `
        query PlayerMarket($slug: String!) {
          football {
            player(slug: $slug) {
              displayName
              cards(rarities: ${rarities}, first: 20) {
                nodes {
                  slug
                  rarityTyped
                  seasonYear
                  serialNumber
                  liveSingleSaleOffer {
                    receiverSide { amounts { eurCents } }
                  }
                }
              }
            }
          }
        }`;
      try {
        const data = await sorareQuery(query, { slug });
        return textResult(data);
      } catch (e) {
        return textResult(
          `Market lookup failed: ${e.message}\n\n` +
            `A field name (e.g. liveSingleSaleOffer / cards) may have changed. ` +
            `Run sorare_get_schema and send the relevant part to fix the query.`
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
