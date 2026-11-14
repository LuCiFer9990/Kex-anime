# Ani-CLI Web

A mobile-friendly anime discovery and playback interface powered by the official **anipy-api** provider library from [sdaqo/anipy-cli](https://github.com/sdaqo/anipy-cli). AniList remains the metadata catalogue; all episode-source search and resolution is handled by anipy-api providers. The previous site-specific HiAnime scraper has been removed.

## Features
- Search and browse anime using AniList metadata
- Anime details, genres, ratings and episode selection
- Episode source search and resolution through registered anipy-api providers
- Provider quality selection and subtitle tracks when supplied by the provider
- HLS.js/native HLS playback, subject to media-host browser/CORS support
- External-player handoff (VLC / MX Player) and stream-link copying
- MP4 downloads when the provider returns a directly downloadable MP4 source
- Persistent favorites and watch progress

## Runtime requirements
- Node.js 20+
- Python 3.10+
- A persistent writable data directory for SQLite

The Docker image installs Node.js, Python and the pinned anipy-api dependency, then runs the Node web server and the small Python bridge in the same container.

## Run locally

```bash
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Start the provider bridge in one terminal:

```bash
uvicorn anipy_bridge:app --host 127.0.0.1 --port 8000
```

Start the website in another terminal:

```bash
npm start
```

Open http://localhost:3000. The default bridge URL is `http://127.0.0.1:8000`; set `ANIPY_API_URL` if the bridge runs elsewhere.

## Docker

```bash
docker compose up --build -d
```

The compose file starts both services inside the app container and persists SQLite data in the `ani_data` volume. For a public deployment, use HTTPS and persistent storage.

## Provider integration

The backend imports `list_providers`, `LanguageTypeEnum`, and provider methods from `anipy_api.provider`. It searches the providers registered by the installed anipy-api release (excluding the local-filesystem provider), matches the requested title, checks the requested episode/language, and returns available stream qualities and subtitle metadata.

The provider set is controlled by the installed anipy-api release. A provider can stop working when its upstream website changes; availability is not guaranteed. The bridge does not solve CAPTCHAs, evade anti-bot controls, bypass authentication, or defeat DRM.

### Browser playback limitations

A stream being resolved does not guarantee that a browser can play it. HLS media hosts may reject browser requests because of CORS, expiring URLs, required request headers, or unsupported codecs. The app relays media requests only to the HTTPS host returned by the provider and forwards the provider referrer; it does not bypass DRM or access controls. If browser playback is blocked, use the VLC / MX Player handoff when the device supports it.

Use only content and services you are authorized to access and stream, and follow the source sites' terms and applicable law.

## AniList and user data

AniList supplies catalogue metadata only; it does not supply video streams. Favorites and watch progress are stored in SQLite and associated with an anonymous browser client ID. For public multi-user deployment, replace this with real authentication.

## API
- GET /api/anime/trending
- GET /api/anime/search?q=...
- GET /api/anime/:id
- GET /api/anime/:id/sources/:episode?language=sub|dub
- GET/POST /api/me/favorites; DELETE /api/me/favorites/:animeId
- GET/POST /api/me/progress
- GET /api/health

## Attribution and licensing

This project integrates [anipy-cli / anipy-api](https://github.com/sdaqo/anipy-cli), Copyright its respective contributors, licensed under GPL-3.0. See the upstream repository for its license and notices. Review GPL-3.0 obligations before distributing modified or combined builds.
