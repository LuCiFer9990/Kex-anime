# Ani-CLI Web

A full-stack browser app inspired by `pystardust/ani-cli`. It uses AniList for catalog metadata, SQLite for favorites/watch progress, and a built-in HiAnime page scraper for episode-source lookup.

## Features
- Search and browse anime from AniList
- Anime details, genres, ratings and episode selection
- Built-in website scraper: search page → episode list → server list → embed page → HLS playlist
- HLS.js/native HLS playback and subtitle tracks when the media host permits browser playback
- MP4 episode downloads with progress feedback (HLS downloads are not included)
- Persistent favorites and watch progress
- Admin API for manually configured authorized HLS/MP4 sources

## Requirements
Node.js 20+ and npm.

## Run locally
```bash
cp .env.example .env
npm install
npm start
```
Open http://localhost:3000.

## Built-in scraper
The default playback resolver makes normal HTTPS page requests to the site configured by `HIANIME_BASE_URL`. It follows the same broad flow used by ani-cli: search the website, retrieve the selected anime's episode markup, retrieve the episode's server markup, open the selected embed page, and read its exposed HLS playlist and subtitle tracks.

The episode and server listing requests are the website's own internal page endpoints, not an external playback-provider service. No `PLAYBACK_PROVIDER_URL` or separate provider API needs to be configured.

The scraper prefers the ZokoAnime subtitle server when it is listed, then tries other subtitle servers exposed by the page. It only accepts embed pages matching the currently implemented playlist format; other embed formats are reported as unsupported rather than guessed. Site markup, domains, embed formats and server names can change, so the integration may need maintenance when the site changes. Trying additional listed servers improves compatibility but does not guarantee that any source will be available or playable. It does not solve CAPTCHAs, evade Cloudflare or other anti-bot controls, defeat DRM, or bypass authentication/access restrictions. If the site blocks the server, the app reports the block rather than attempting to evade it.

### Browser playback limitations
Finding a playlist does not guarantee that a browser can play it. The media host must allow cross-origin requests from your app. Some streams also require request headers or session state that a browser video element cannot set. In those cases the scraper can resolve the source but playback may still fail; this app does not proxy or strip provider protections.

Use this integration only for content and services you are authorized to access and stream, and comply with the source site's terms and applicable law.

## Configure an authorized manual source
AniList provides metadata, not video streams. You can still add a direct stream URL that you own or are authorized to distribute. Set `ADMIN_TOKEN`, then call:

```bash
curl -X POST http://localhost:3000/api/admin/sources \
  -H 'content-type: application/json' \
  -H 'x-admin-token: YOUR_ADMIN_TOKEN' \
  -d '{"animeId":21,"episode":1,"label":"Official stream","type":"hls","url":"https://your-authorized-host.example/video/episode-1.m3u8"}'
```

Supported types: `hls` and `mp4`. Manually configured sources take precedence over scraper lookup. Configure CORS on your media host to allow your app's origin.

## API
- GET /api/anime/trending
- GET /api/anime/search?q=...
- GET /api/anime/:id
- GET /api/anime/:id/sources/:episode
- GET/POST /api/me/favorites; DELETE /api/me/favorites/:animeId
- GET/POST /api/me/progress

User state uses an anonymous browser client ID. For public multi-user deployment, replace it with real authentication.

## Deployment
Deploy on a Node.js host with persistent disk storage. Set `ADMIN_TOKEN` and `DATABASE_PATH`, use HTTPS, and persist the data directory. Docker: `ADMIN_TOKEN=$(openssl rand -hex 32) docker compose up --build -d`.
