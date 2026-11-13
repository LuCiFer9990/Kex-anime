const BASE = (process.env.HIANIME_BASE_URL || "https://hianime.at").replace(/\/$/, "");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const KEY = Buffer.from("otaku-embed-v1", "utf8");

function decodeEntities(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function attr(html, name) {
  const match = html.match(new RegExp('\\\\b' + name + '=["\\\\']([^"\\\\']*)["\\\\']', "i"));
  return match ? decodeEntities(match[1]) : "";
}
function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
async function getText(url, referer = BASE + "/") {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,*/*", referer },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HiAnime returned HTTP ${response.status}`);
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

export async function searchAnime(query) {
  const url = new URL("/search", BASE);
  url.searchParams.set("keyword", String(query).slice(0, 100));
  const html = await getText(url.toString());
  const results = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*film-detail[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const match = block.match(/<a\\s+[^>]*href=["'](?:https?:\\/\\/[^/]+)?\\/watch\\/([^"'?]+)[^"']*["'][^>]*title=["']([^"']+)["']/i)
      || block.match(/<a\\s+[^>]*title=["']([^"']+)["'][^>]*href=["'](?:https?:\\/\\/[^/]+)?\\/watch\\/([^"'?]+)[^"']*["']/i);
    if (!match) continue;
    const slug = match[1].includes("/") ? match[1] : match[1];
    const title = decodeEntities(match[2] || "");
    if (slug && title) results.push({ slug, title });
    if (results.length >= 20) break;
  }
  return results;
}

export async function getEpisodeMap(slug) {
  const id = String(slug).split("-").at(-1);
  if (!/^\\d+$/.test(id)) throw new Error("Invalid HiAnime anime slug");
  const html = await getText(new URL(`/api/theme/episode/list/${id}`, BASE).toString());
  const normalized = html.replace(/\\\\+"/g, '"').replace(/\\\\\\//g, "/");
  const episodes = [];
  for (const block of normalized.split(/ep-item/i).slice(1)) {
    const number = attr(block, "data-number");
    const episodeId = attr(block, "data-id");
    if (number && /^\\d+$/.test(episodeId)) episodes.push({ number: Number(number), id: episodeId });
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
  if (!selected) throw new Error(`Episode ${episode} was not found on HiAnime`);

  const serverUrl = new URL("/api/theme/episode/servers", BASE);
  serverUrl.searchParams.set("episodeId", selected.id);
  const serverHtml = (await getText(serverUrl.toString())).replace(/\\\\+"/g, '"').replace(/\\\\\\//g, "/");
  const serverBlocks = serverHtml.split(/server-item/i).slice(1);
  const server = serverBlocks.find(block => /data-server-name=["']ZokoAnime["']/i.test(block)
    && new RegExp('data-type=["\\\\']sub["\\\\']', "i").test(block));
  if (!server) throw new Error("HiAnime did not return the supported ZokoAnime sub server");
  const encoded = attr(server, "data-hash");
  if (!encoded) throw new Error("The selected server did not include an embed link");
  let embedUrl;
  try { embedUrl = Buffer.from(encoded, "base64").toString("utf8"); new URL(embedUrl); }
  catch { throw new Error("The server returned an invalid embed URL"); }
  const embed = await getText(embedUrl, new URL(embedUrl).origin + "/");
  const blob = embed.match(/window\\.__P\\s*=\\s*["']([^"']+)["']/)?.[1];
  if (!blob) throw new Error("The embed page did not expose a supported playlist configuration");
  let config;
  try { config = JSON.parse(deobfuscate(blob)); }
  catch { throw new Error("Could not parse the embed playlist configuration"); }
  const playlist = config.src || config.source || config.sources?.[0]?.src;
  if (typeof playlist !== "string" || !/\\.m3u8(?:[?#]|$)/i.test(playlist)) {
    throw new Error("No HLS playlist was found in the embed configuration");
  }
  const parsedPlaylist = new URL(playlist, embedUrl);
  if (parsedPlaylist.protocol !== "https:") throw new Error("The provider returned a non-HTTPS playlist");

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

  return {
    provider: `HiAnime · ${match.title}`,
    sources: [{ url: parsedPlaylist.toString(), type: "hls", label: "ZokoAnime", quality: "Auto", subtitles }]
  };
}
