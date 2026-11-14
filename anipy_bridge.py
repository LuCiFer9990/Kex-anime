"""Small HTTP adapter around the official anipy-api provider interface.

The adapter deliberately uses only providers registered by anipy-api. It does
not automate CAPTCHA solving, authentication bypasses, or DRM circumvention.
"""
from difflib import SequenceMatcher
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from anipy_api.provider import LanguageTypeEnum, list_providers

app = FastAPI(title="anipy-api bridge", docs_url=None, redoc_url=None)


def provider_classes():
    return [cls for cls in list_providers() if cls.NAME.lower() != "native"]


def serialize_search(item: Any):
    return {
        "identifier": item.identifier,
        "name": item.name,
        "languages": sorted(lang.value for lang in item.languages),
    }


def serialize_stream(stream: Any):
    subtitles = []
    for key, sub in (stream.subtitle or {}).items():
        subtitles.append({
            "url": sub.url,
            "label": key or sub.lang or "Subtitles",
            "lang": sub.shortcode or sub.lang or "und",
            "codec": sub.codec,
        })
    return {
        "url": stream.url,
        # Extensionless provider URLs are common; let the relay inspect the
        # upstream response instead of incorrectly labelling them as MP4.
        "type": "hls" if ".m3u8" in stream.url.lower() else ("mp4" if ".mp4" in stream.url.lower() else "auto"),
        "resolution": stream.resolution,
        "quality": f"{stream.resolution}p" if stream.resolution else "Auto",
        "language": stream.language.value,
        "referrer": stream.referrer,
        "subtitles": subtitles,
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "anipy-api"}


@app.get("/providers")
def providers():
    return [{"name": cls.NAME} for cls in provider_classes()]


@app.get("/search")
def search(q: str = Query(min_length=1, max_length=100), provider: str | None = None):
    found = []
    failures = []
    classes = provider_classes()
    if provider:
        classes = [cls for cls in classes if cls.NAME.lower() == provider.lower()]
        if not classes:
            raise HTTPException(404, "Unknown anipy-api provider")
    for cls in classes:
        instance = cls()
        try:
            results = instance.get_search(q)
            found.extend({
                "provider": cls.NAME,
                **serialize_search(item),
            } for item in results[:30])
        except Exception as exc:
            failures.append(f"{cls.NAME}: {exc}")
    if not found and failures:
        raise HTTPException(502, "; ".join(failures[:3]))
    return {"results": found}


class ResolveRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    episode: float = Field(gt=0)
    language: str = "sub"
    provider: str | None = None


@app.post("/resolve")
def resolve(body: ResolveRequest):
    wanted = " ".join(body.title.lower().split())
    lang_name = body.language.lower()
    requested_lang = LanguageTypeEnum.DUB if lang_name == "dub" else LanguageTypeEnum.SUB
    classes = provider_classes()
    if body.provider:
        classes = [cls for cls in classes if cls.NAME.lower() == body.provider.lower()]
        if not classes:
            raise HTTPException(404, "Unknown anipy-api provider")

    failures = []
    for cls in classes:
        instance = cls()
        try:
            results = instance.get_search(body.title)
            if not results:
                continue
            ranked = sorted(
                results,
                key=lambda item: SequenceMatcher(
                    None, wanted, " ".join(item.name.lower().split())
                ).ratio(),
                reverse=True,
            )
            match = ranked[0]
            score = SequenceMatcher(
                None, wanted, " ".join(match.name.lower().split())
            ).ratio()
            if score < 0.42:
                continue
            lang = requested_lang
            if lang not in match.languages:
                continue
            episodes = instance.get_episodes(match.identifier, lang)
            episode = next((ep for ep in episodes if float(ep) == body.episode), None)
            if episode is None:
                continue
            streams = instance.get_video(match.identifier, episode, lang)
            streams.sort(key=lambda item: item.resolution, reverse=True)
            if not streams:
                continue
            return {
                "provider": cls.NAME,
                "matchedAnime": match.name,
                "episode": episode,
                "language": lang.value,
                "sources": [serialize_stream(stream) for stream in streams],
            }
        except Exception as exc:
            failures.append(f"{cls.NAME}: {exc}")
    detail = "; ".join(failures[:3])
    raise HTTPException(502, detail or "No matching anime episode or stream was found")
