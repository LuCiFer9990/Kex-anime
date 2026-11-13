const endpoint = process.env.PLAYBACK_PROVIDER_URL;
const token = process.env.PLAYBACK_PROVIDER_TOKEN;

function safeHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Adapter contract for a provider you own or are authorized to use.
 * POST { anime: { id, title, romaji, english, seasonYear, format }, episode }
 * Expected JSON: { provider: string, sources: [{ url, type, label, quality?, subtitles? }] }
 */
export async function resolveEpisode({ anime, episode }) {
  if (!endpoint) return null;
  const apiUrl = safeHttps(endpoint);
  if (!apiUrl) throw new Error("PLAYBACK_PROVIDER_URL must be an HTTPS endpoint");

  const headers = { "content-type": "application/json", accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      anime: {
        id: anime.id,
        title: anime.title?.english || anime.title?.romaji || "Unknown anime",
        romaji: anime.title?.romaji || null,
        english: anime.title?.english || null,
        seasonYear: anime.seasonYear || null,
        format: anime.format || null
      },
      episode
    })
  });
  if (!response.ok) throw new Error(`Playback provider returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.sources)) return { provider: payload.provider || "Configured provider", sources: [] };

  const sources = payload.sources.slice(0, 8).flatMap((item) => {
    const url = safeHttps(item.url);
    if (!url || !["hls", "mp4"].includes(item.type)) return [];
    const subtitles = Array.isArray(item.subtitles) ? item.subtitles.slice(0, 12).flatMap((track) => {
      const trackUrl = safeHttps(track.url);
      return trackUrl ? [{
        url: trackUrl,
        label: String(track.label || track.lang || "Subtitles").slice(0, 60),
        lang: String(track.lang || "und").slice(0, 12),
        default: Boolean(track.default)
      }] : [];
    }) : [];
    return [{
      url,
      type: item.type,
      label: String(item.label || payload.provider || "Playback source").slice(0, 80),
      quality: String(item.quality || "").slice(0, 24),
      subtitles
    }];
  });
  return { provider: String(payload.provider || "Configured provider").slice(0, 80), sources };
}
