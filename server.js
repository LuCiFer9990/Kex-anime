import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEpisode } from "./providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "data", "ani-cli-web.sqlite");
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS favorites(client_id TEXT NOT NULL, anime_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(client_id, anime_id));
  CREATE TABLE IF NOT EXISTS progress(client_id TEXT NOT NULL, anime_id INTEGER NOT NULL, episode INTEGER NOT NULL, position REAL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(client_id, anime_id));
  CREATE TABLE IF NOT EXISTS sources(anime_id INTEGER NOT NULL, episode INTEGER NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(anime_id, episode));
`);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const validClient = (v) => typeof v === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(v);
app.use("/api", (req, res, next) => {
  const id = req.get("x-client-id");
  if (req.path.startsWith("/admin/")) return next();
  if (!validClient(id)) return res.status(400).json({ error: "A valid X-Client-Id header is required." });
  req.clientId = id;
  next();
});
const query = (text, variables = {}) => fetch("https://graphql.anilist.co", {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "application/json" },
  body: JSON.stringify({ query: text, variables })
}).then(async r => {
  if (!r.ok) throw new Error(`AniList returned ${r.status}`);
  const data = await r.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
});
const mediaFields = `id title { romaji english native } description(asHtml:false) coverImage { extraLarge large } bannerImage episodes averageScore seasonYear season format status genres duration studios { nodes { name } }`;
const mediaQuery = `query($id:Int){ Media(id:$id,type:ANIME){ ${mediaFields} } }`;
const mapError = (res, e) => res.status(502).json({ error: e.message || "Upstream service unavailable" });

app.get("/api/anime/trending", async (req, res) => {
  try {
    const sort = ["TRENDING_DESC", "POPULARITY_DESC", "SCORE_DESC"].includes(req.query.sort) ? req.query.sort : "TRENDING_DESC";
    const data = await query(`query($sort:[MediaSort]){ Page(page:1,perPage:24){ media(type:ANIME,sort:$sort,isAdult:false){ ${mediaFields} } } }`, { sort: [sort] });
    res.json(data.Page.media);
  } catch (e) { mapError(res, e); }
});
app.get("/api/anime/search", async (req, res) => {
  const term = String(req.query.q || "").trim().slice(0, 100);
  if (!term) return res.json([]);
  try {
    const data = await query(`query($search:String){ Page(page:1,perPage:24){ media(type:ANIME,search:$search,sort:[SEARCH_MATCH,POPULARITY_DESC],isAdult:false){ ${mediaFields} } } }`, { search: term });
    res.json(data.Page.media);
  } catch (e) { mapError(res, e); }
});
app.get("/api/anime/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid anime id" });
  try {
    const data = await query(mediaQuery, { id });
    if (!data.Media) return res.status(404).json({ error: "Anime not found" });
    res.json(data.Media);
  } catch (e) { mapError(res, e); }
});
app.get("/api/anime/:id/sources/:episode", async (req, res) => {
  const id = Number(req.params.id), episode = Number(req.params.episode);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(episode) || id < 1 || episode < 1) return res.status(400).json({ error: "Invalid anime or episode id" });

  const configured = db.prepare("SELECT label,type,url FROM sources WHERE anime_id=? AND episode=?").get(id, episode);
  if (configured) return res.json({ provider: "Site-configured source", sources: [{ ...configured, quality: "", subtitles: [] }] });

  try {
    const data = await query(mediaQuery, { id });
    if (!data.Media) return res.status(404).json({ error: "Anime not found" });
    const resolved = await resolveEpisode({ anime: data.Media, episode });
    res.json(resolved || { provider: null, sources: [] });
  } catch (e) {
    res.status(502).json({ error: e.message || "Playback provider unavailable" });
  }
});

app.get("/api/me/favorites", (req, res) => {
  const rows = db.prepare("SELECT anime_id FROM favorites WHERE client_id=? ORDER BY created_at DESC").all(req.clientId);
  res.json(rows.map(x => x.anime_id));
});
app.post("/api/me/favorites", (req, res) => {
  const id = Number(req.body.animeId);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid animeId" });
  db.prepare("INSERT OR IGNORE INTO favorites(client_id,anime_id) VALUES(?,?)").run(req.clientId, id);
  res.status(201).json({ ok: true });
});
app.delete("/api/me/favorites/:animeId", (req, res) => {
  db.prepare("DELETE FROM favorites WHERE client_id=? AND anime_id=?").run(req.clientId, Number(req.params.animeId));
  res.json({ ok: true });
});
app.get("/api/me/progress", (req, res) => {
  res.json(db.prepare("SELECT anime_id AS animeId,episode,position,updated_at AS updatedAt FROM progress WHERE client_id=? ORDER BY updated_at DESC LIMIT 50").all(req.clientId));
});
app.post("/api/me/progress", (req, res) => {
  const { animeId, episode, position = 0 } = req.body || {};
  if (![animeId, episode].every(x => Number.isSafeInteger(Number(x)) && Number(x) > 0) || !Number.isFinite(Number(position)) || Number(position) < 0) return res.status(400).json({ error: "Invalid progress payload" });
  db.prepare(`INSERT INTO progress(client_id,anime_id,episode,position,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(client_id,anime_id) DO UPDATE SET episode=excluded.episode,position=excluded.position,updated_at=CURRENT_TIMESTAMP`)
    .run(req.clientId, Number(animeId), Number(episode), Number(position));
  res.json({ ok: true });
});

function adminOnly(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  const supplied = crypto.createHash("sha256").update(String(req.get("x-admin-token") || "")).digest();
  const configured = crypto.createHash("sha256").update(String(expected || "missing-admin-token")).digest();
  if (!expected || !crypto.timingSafeEqual(supplied, configured)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
app.post("/api/admin/sources", adminOnly, (req, res) => {
  const { animeId, episode, label = "Authorized stream", type, url } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "A valid stream URL is required" }); }
  if (!Number.isSafeInteger(Number(animeId)) || Number(animeId) < 1 || !Number.isSafeInteger(Number(episode)) || Number(episode) < 1) return res.status(400).json({ error: "Invalid animeId or episode" });
  if (!["https:", "http:"].includes(parsed.protocol) || !["hls", "mp4"].includes(type)) return res.status(400).json({ error: "Only HTTP(S) HLS or MP4 sources are supported" });
  db.prepare(`INSERT INTO sources(anime_id,episode,label,type,url) VALUES(?,?,?,?,?)
    ON CONFLICT(anime_id,episode) DO UPDATE SET label=excluded.label,type=excluded.type,url=excluded.url`)
    .run(Number(animeId), Number(episode), String(label).slice(0,80), type, parsed.toString());
  res.status(201).json({ ok: true });
});
app.delete("/api/admin/sources/:animeId/:episode", adminOnly, (req, res) => {
  db.prepare("DELETE FROM sources WHERE anime_id=? AND episode=?").run(Number(req.params.animeId), Number(req.params.episode));
  res.json({ ok: true });
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(port, () => console.log(`Ani-CLI Web running at http://localhost:${port}`));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "ani-cli-web" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
