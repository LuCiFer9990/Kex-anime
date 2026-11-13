# Ani-CLI Web

A full-stack browser UI inspired by pystardust/ani-cli. It uses AniList for anime metadata and SQLite for favorites and watch progress.

## Features
- Search and browse anime from AniList
- Anime details, genres, ratings and episode selection
- HLS (.m3u8) and MP4 playback in the browser
- MP4 episode downloads with progress feedback (requires media-host CORS; HLS package downloads are not included)
- Persistent favorites and watch progress
- Admin API for authorized playback sources
- Responsive mobile-first UI

## Requirements
Node.js 20+ and npm.

## Run locally
```bash
cp .env.example .env
npm install
npm start
```
Open http://localhost:3000.

## Configure playback
AniList supplies metadata, not video streams. To make an episode playable, add a stream URL that you own or are authorized to distribute. Set ADMIN_TOKEN in .env, then call:

```bash
curl -X POST http://localhost:3000/api/admin/sources \
  -H 'content-type: application/json' \
  -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  -d '{"animeId":21,"episode":1,"label":"Official stream","type":"hls","url":"https://your-authorized-host.example/video/episode-1.m3u8"}'
```

Supported types: hls and mp4. Configure CORS on your media host to allow your app's origin. Remove a source with DELETE /api/admin/sources/:animeId/:episode and the same admin header.

## Browser playback provider integration

The browser app can now use a pluggable provider API. Set `PLAYBACK_PROVIDER_URL` to an HTTPS endpoint you operate or are authorized to use, and optionally set `PLAYBACK_PROVIDER_TOKEN`. When no manually configured source exists for an episode, the server sends a JSON `POST` request to that endpoint:

```json
{
  "anime": { "id": 21, "title": "Example anime", "romaji": "Example anime", "english": "Example anime", "seasonYear": 2024, "format": "TV" },
  "episode": 1
}
```

The endpoint should return JSON in this shape:

```json
{
  "provider": "My authorized catalog",
  "sources": [
    {
      "label": "1080p",
      "type": "hls",
      "quality": "1080p",
      "url": "https://media.example.com/episode-1/master.m3u8",
      "subtitles": [
        { "url": "https://media.example.com/episode-1/en.vtt", "label": "English", "lang": "en", "default": true }
      ]
    }
  ]
}
```

Only HTTPS source and subtitle URLs are accepted. The player uses HLS.js where supported, offers adaptive/manual HLS quality selection, and attaches WebVTT subtitle tracks. Native HLS quality selection is handled by the browser. Cross-origin media and subtitle hosts must permit playback from your app origin. The adapter does not scrape third-party streaming sites, defeat DRM, or bypass provider access controls. A compatible provider API and its authorization are required; no provider is bundled or enabled by default. Manual admin-configured sources continue to take precedence. If playback is not configured, the episode API returns `status: "not_configured"` with setup guidance; if the provider is configured but has no source for an episode, it returns `status: "no_sources"`. A successful source response returns `status: "ready"`.

## API
- GET /api/anime/trending
- GET /api/anime/search?q=...
- GET /api/anime/:id
- GET /api/anime/:id/sources/:episode
- GET/POST /api/me/favorites; DELETE /api/me/favorites/:animeId
- GET/POST /api/me/progress

User state uses an anonymous browser client ID. For public multi-user deployment, replace it with real authentication.

## Deployment
Deploy on a Node.js host with persistent disk storage. Set ADMIN_TOKEN and DATABASE_PATH, use HTTPS, and persist the data directory. Docker: `ADMIN_TOKEN=$(openssl rand -hex 32) docker compose up --build -d`.

## Legal / technical boundary
This app does not scrape third-party streaming sites, defeat access controls, or redistribute copyrighted streams. Playback requires direct media sources you are authorized to use. Browser CORS and playback restrictions apply.
