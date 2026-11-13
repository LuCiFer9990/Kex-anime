const BASE = (process.env.HIANIME_BASE_URL || "https://hianime.at").replace(/\/$/, "");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const KEY = Buffer.from("otaku-embed-v1", "utf8");

function decodeEntities(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function attr(html, name) {
  const match = html.match(new RegExp('(?:^|\\s)' + name + '=["\\x27]([^"\\x27]*)["\\x27]', "i"));
  return match ? decodeEntities(match[1]) : "";
}
function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
async function getText(url, referer = BASE + "/") {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,*/*", referer },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error('Upstream returned HTTP ' + response.status + ' for ' + new URL(url).pathname);
  if (/Just a moment|cf-chl-|challenge-platform/i.test(body.slice(0, 5000))) {
    throw new Error("HiAnime blocked this server request. The scraper does not bypass anti-bot checks.");
  }
  return body;
}
function deobfuscate(value) {
  const bytes = Buffer.from(value, "base64");
  const decoded = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) decoded[i] = bytes[i] ^ KEY[i % KEY.length];
  return decoded.toString("utf8");
}
function normalizeMarkup(value) {
  return String(value || "").replace(/\\+"/g, '"').replace(/\\\//g, "/");
}
function extractServers(markup) {
  const blocks = normalizeMarkup(markup).split(/server-item/i).slice(1);
  return blocks.filter(block => /data-type=["']sub["']/i.test(block))
    .map(block => ({
      name: attr(block, "data-server-name") || attr(block, "data-server-id") || "Unknown server",
      encoded: attr(block, "data-hash")
    }))
    .filter(server => server.encoded);
}
function decodeEmbedUrl(encoded) {
  let value;
  try { value = Buffer.from(encoded, "base64").toString("utf8"); }
  catch { throw new Error("Invalid encoded embed URL"); }
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Server returned an invalid embed URL"); }
  if (url.protocol !== "https:") throw new Error("Embed URL must use HTTPS");
  return url.toString();
}
function extractConfig(embed) {
  const blob = embed.match(/window\.__P\s*=\s*["']([^"']+)["']/)?.[1];
  if (!blob) throw new Error("Embed page has no supported playlist configuration");
  let config;
  try { config = JSON.parse(deobfuscate(blob)); }
  catch { throw new Error("Embed playlist configuration could not be decoded"); }
  const playlist = config.src || config.source || config.sources?.[0]?.src;
  if (typeof playlist !== "string" || !/\.m3u8(?:[?#]|$)/i.test(playlist)) {
    throw new Error("Embed configuration contains no HLS playlist");
  }
  return { config, playlist };
}
function buildSource(config, playlist, embedUrl, serverName) {
  const parsed = new URL(playlist, embedUrl);
  if (parsed.protocol !== "https:") throw new Error("Playlist URL must use HTTPS");
  const subtitles = (Array.isArray(config.subtitles) ? config.subtitles : [])
    .filter(track => typeof track.src === "string")
    .slice(0, 8)
    .map(track => {
      const url = new URL(track.src, embedUrl);
      if (url.protocol !== "https:") return null;
      return {
        url: url.toString(),
        label: String(track.label || track.lang || "Subtitles").slice(0, 60),
        lang: String(track.lang || "und").slice(0, 12),
        default: Boolean(track.default)
      };
    }).filter(Boolean);
  return { url: parsed.toString(), type: "hls", label: serverName, quality: "Auto", subtitles };
}

export async function searchAnime(query) {
  const url = new URL("/search", BASE);
  url.searchParams.set("keyword", String(query).slice(0, 100));
  const html = await getText(url.toString());
  const results = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*film-detail[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const href = block.match(/href=["'](?:https?:\/\/[^/]+)?\/watch\/([^"'?]+)/i);
    const heading = block.match(/title=["']([^"']+)["']/i);
    if (!href || !heading) continue;
    const slug = href[1];
    const title = decodeEntities(heading[1]);
    if (slug && title) results.push({ slug, title });
    if (results.length >= 20) break;
  }
  return results;
}

export async function getEpisodeMap(slug) {
  const id = String(slug).split("-").at(-1);
  if (!/^\d+$/.test(id)) throw new Error("Invalid HiAnime anime slug");
  const html = normalizeMarkup(await getText(new URL('/api/theme/episode/list/' + id, BASE).toString()));
  const episodes = [];
  for (const block of html.split(/ep-item/i).slice(1)) {
    const number = attr(block, "data-number");
    const episodeId = attr(block, "data-id");
    if (number && /^\d+$/.test(episodeId)) episodes.push({ number: Number(number), id: episodeId });
  }
  return episodes.sort((a, b) => a.number - b.number);
}

export async function resolveHiAnimeEpisode({ anime, episode }) {
  const query = anime.title?.english || anime.title?.romaji || "";
  if (!query) throw new Error("Anime title is missing");
  const matches = await searchAnime(query);
  if (!matches.length) throw new Error("No matching anime was found on HiAnime");
  const wanted = normalize(query);
  const match = matches.find(item => normalize(item.title) === wanted)
    || matches.find(item => normalize(item.title).includes(wanted) || wanted.includes(normalize(item.title)))
    || matches[0];

  const episodes = await getEpisodeMap(match.slug);
  const selected = episodes.find(item => item.number === Number(episode));
  if (!selected) throw new Error('Episode ' + episode + ' was not found on HiAnime');

  const serverUrl = new URL("/api/theme/episode/servers", BASE);
  serverUrl.searchParams.set("episodeId", selected.id);
  const servers = extractServers(await getText(serverUrl.toString()));
  if (!servers.length) throw new Error("HiAnime returned no subtitle servers with embed links");

  // Prefer the previously supported server, then try other publicly listed subtitle servers.
  const ordered = [...servers].sort((a, b) => Number(/zokoanime/i.test(b.name)) - Number(/zokoanime/i.test(a.name)));
  const failures = [];
  for (const server of ordered) {
    try {
      const embedUrl = decodeEmbedUrl(server.encoded);
      const embed = await getText(embedUrl, new URL(embedUrl).origin + "/");
      const { config, playlist } = extractConfig(embed);
      const source = buildSource(config, playlist, embedUrl, server.name);
      return { provider: 'HiAnime · ' + match.title, sources: [source] };
    } catch (error) {
      failures.push(server.name + ': ' + (error.message || 'unsupported response'));
    }
  }
  throw new Error('No listed subtitle server returned a supported HLS playlist. ' + failures.slice(0, 4).join(' | '));
}
