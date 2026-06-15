#!/usr/bin/env python3
"""Find businesses that appear not to have a website.

This CLI uses free public sources:
- Nominatim to turn a place name into a bounding box.
- OpenStreetMap Overpass to find businesses in that box.
- Optional DuckDuckGo HTML results to look for an official website candidate.

It does not use Google Places, Yelp, paid APIs, or API keys.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote_plus, unquote, urlencode, urlparse
from urllib.request import Request, urlopen


USER_AGENT = "company-no-website-finder/1.0 (local research tool)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/"

DIRECTORY_DOMAINS = {
    "angi.com",
    "bbb.org",
    "bing.com",
    "chamberofcommerce.com",
    "citysearch.com",
    "facebook.com",
    "foursquare.com",
    "google.com",
    "groupon.com",
    "instagram.com",
    "linkedin.com",
    "mapquest.com",
    "nextdoor.com",
    "opencorporates.com",
    "thebluebook.com",
    "tripadvisor.com",
    "twitter.com",
    "x.com",
    "yellowpages.com",
    "yelp.com",
    "zillow.com",
}

CATEGORY_QUERIES = {
    "all": [
        ("shop", None),
        ("craft", None),
        ("office", "company"),
    ],
    "auto": [
        ("shop", "car_repair"),
        ("shop", "car"),
        ("shop", "tyres"),
    ],
    "cleaning": [
        ("shop", "cleaning"),
        ("craft", "cleaning"),
    ],
    "contractors": [
        ("craft", None),
        ("office", "company"),
    ],
    "electricians": [
        ("craft", "electrician"),
    ],
    "lawn": [
        ("shop", "garden_centre"),
        ("craft", "gardener"),
        ("craft", "landscaper"),
    ],
    "plumbers": [
        ("craft", "plumber"),
    ],
    "restaurants": [
        ("amenity", "restaurant"),
        ("amenity", "cafe"),
        ("amenity", "fast_food"),
        ("amenity", "bar"),
        ("amenity", "pub"),
    ],
    "retail": [
        ("shop", None),
    ],
}

WEBSITE_KEYS = {
    "website",
    "contact:website",
    "url",
    "contact:url",
}

PHONE_KEYS = ("phone", "contact:phone")
EMAIL_KEYS = ("email", "contact:email")


@dataclass
class BusinessLead:
    name: str
    source_category: str
    osm_type: str
    osm_id: int
    osm_url: str
    address: str
    phone: str
    email: str
    source_has_website: bool
    official_site_candidate: str
    no_website_confidence: str
    notes: str


class DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attrs_dict = dict(attrs)
        href = attrs_dict.get("href")
        css_class = attrs_dict.get("class") or ""
        if href and "result__a" in css_class:
            self.links.append(html.unescape(href))


def http_get(url: str, params: dict[str, str] | None = None, timeout: int = 30) -> bytes:
    if params:
        url = f"{url}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def http_post(url: str, data: str, timeout: int = 60) -> bytes:
    encoded = data.encode("utf-8")
    request = Request(
        url,
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def geocode_place(place: str) -> tuple[float, float, float, float]:
    payload = http_get(
        NOMINATIM_URL,
        {
            "q": place,
            "format": "jsonv2",
            "limit": "1",
        },
    )
    results = json.loads(payload.decode("utf-8"))
    if not results:
        raise ValueError(f"No geocoding result found for place: {place}")
    south, north, west, east = [float(value) for value in results[0]["boundingbox"]]
    return south, west, north, east


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be south,west,north,east")
    try:
        south, west, north, east = (float(part) for part in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("bbox values must be numbers") from exc
    if south >= north or west >= east:
        raise argparse.ArgumentTypeError("bbox must be ordered south,west,north,east")
    return south, west, north, east


def normalize_categories(categories: str) -> list[str]:
    selected = [item.strip().lower() for item in categories.split(",") if item.strip()]
    unknown = sorted(set(selected) - set(CATEGORY_QUERIES))
    if unknown:
        valid = ", ".join(sorted(CATEGORY_QUERIES))
        raise ValueError(f"Unknown category {unknown[0]!r}. Valid categories: {valid}")
    return selected or ["all"]


def category_filters(categories: Iterable[str]) -> list[tuple[str, str | None]]:
    filters: list[tuple[str, str | None]] = []
    seen: set[tuple[str, str | None]] = set()
    for category in categories:
        for item in CATEGORY_QUERIES[category]:
            if item not in seen:
                filters.append(item)
                seen.add(item)
    return filters


def build_overpass_query(
    bbox: tuple[float, float, float, float], filters: Iterable[tuple[str, str | None]]
) -> str:
    south, west, north, east = bbox
    bbox_text = f"{south},{west},{north},{east}"
    clauses = []
    for key, value in filters:
        if value is None:
            clauses.append(f'nwr["{key}"]({bbox_text});')
        else:
            clauses.append(f'nwr["{key}"="{value}"]({bbox_text});')
    body = "\n  ".join(clauses)
    return f"""[out:json][timeout:60];
(
  {body}
);
out center tags;"""


def fetch_osm_businesses(
    bbox: tuple[float, float, float, float], filters: Iterable[tuple[str, str | None]]
) -> list[dict]:
    query = build_overpass_query(bbox, filters)
    payload = http_post(OVERPASS_URL, f"data={quote_plus(query)}")
    data = json.loads(payload.decode("utf-8"))
    return data.get("elements", [])


def tag_value(tags: dict[str, str], keys: Iterable[str]) -> str:
    for key in keys:
        value = tags.get(key)
        if value:
            return value.strip()
    return ""


def build_address(tags: dict[str, str]) -> str:
    address_parts = [
        tags.get("addr:housenumber", ""),
        tags.get("addr:street", ""),
        tags.get("addr:city", ""),
        tags.get("addr:state", ""),
        tags.get("addr:postcode", ""),
    ]
    return " ".join(part.strip() for part in address_parts if part and part.strip())


def source_category(tags: dict[str, str]) -> str:
    for key in ("amenity", "shop", "craft", "office", "industrial"):
        if tags.get(key):
            return f"{key}:{tags[key]}"
    return "unknown"


def has_source_website(tags: dict[str, str]) -> bool:
    return any(bool(tags.get(key, "").strip()) for key in WEBSITE_KEYS)


def osm_url(osm_type: str, osm_id: int) -> str:
    type_map = {"node": "node", "way": "way", "relation": "relation"}
    return f"https://www.openstreetmap.org/{type_map.get(osm_type, osm_type)}/{osm_id}"


def extract_duckduckgo_target(url: str) -> str:
    parsed = urlparse(url)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        return unquote(target)
    return url


def domain_of(url: str) -> str:
    parsed = urlparse(url)
    domain = parsed.netloc.lower()
    if domain.startswith("www."):
        domain = domain[4:]
    return domain


def is_directory_or_social(url: str) -> bool:
    domain = domain_of(url)
    return any(domain == blocked or domain.endswith(f".{blocked}") for blocked in DIRECTORY_DOMAINS)


def search_official_site(name: str, place: str, delay_seconds: float) -> str:
    time.sleep(delay_seconds)
    query = f'"{name}" "{place}" official website'
    try:
        payload = http_get(DUCKDUCKGO_HTML_URL, {"q": query}, timeout=30)
    except (HTTPError, URLError, TimeoutError):
        return ""
    parser = DuckDuckGoParser()
    parser.feed(payload.decode("utf-8", errors="ignore"))
    for raw_link in parser.links:
        target = extract_duckduckgo_target(raw_link)
        if target.startswith("http") and not is_directory_or_social(target):
            return target
    return ""


def make_leads(
    elements: Iterable[dict],
    place: str,
    verify_search: bool,
    search_delay: float,
) -> list[BusinessLead]:
    leads: list[BusinessLead] = []
    seen: set[tuple[str, str]] = set()
    for element in elements:
        tags = element.get("tags") or {}
        name = tags.get("name", "").strip()
        if not name:
            continue

        source_has_site = has_source_website(tags)
        if source_has_site:
            continue

        address = build_address(tags)
        dedupe_key = (name.lower(), address.lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        official_site = ""
        confidence = "medium"
        notes = "No website tag found in OpenStreetMap source data."
        if verify_search:
            official_site = search_official_site(name, place, search_delay)
            if official_site:
                confidence = "low"
                notes = "No OSM website tag, but a possible official site was found by search."
            else:
                confidence = "high"
                notes = "No OSM website tag and no official site found in lightweight search."

        osm_type = element.get("type", "")
        osm_id = int(element.get("id", 0))
        leads.append(
            BusinessLead(
                name=name,
                source_category=source_category(tags),
                osm_type=osm_type,
                osm_id=osm_id,
                osm_url=osm_url(osm_type, osm_id),
                address=address,
                phone=tag_value(tags, PHONE_KEYS),
                email=tag_value(tags, EMAIL_KEYS),
                source_has_website=source_has_site,
                official_site_candidate=official_site,
                no_website_confidence=confidence,
                notes=notes,
            )
        )
    return leads


def write_csv(path: Path, leads: Iterable[BusinessLead]) -> None:
    rows = [asdict(lead) for lead in leads]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(BusinessLead.__dataclass_fields__))
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, leads: Iterable[BusinessLead]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump([asdict(lead) for lead in leads], handle, indent=2)
        handle.write("\n")


def filtered_leads(leads: list[BusinessLead], only_likely_no_website: bool) -> list[BusinessLead]:
    if not only_likely_no_website:
        return leads
    return [lead for lead in leads if lead.no_website_confidence in {"medium", "high"}]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find businesses that are missing website data and may not have websites."
    )
    parser.add_argument("--place", default="Austin, Texas", help="Place to search.")
    parser.add_argument(
        "--bbox",
        type=parse_bbox,
        help="Optional bounding box as south,west,north,east. Skips geocoding when supplied.",
    )
    parser.add_argument(
        "--categories",
        default="all",
        help=f"Comma-separated categories. Valid: {', '.join(sorted(CATEGORY_QUERIES))}",
    )
    parser.add_argument("--limit", type=int, default=100, help="Maximum leads to write.")
    parser.add_argument(
        "--verify-search",
        action="store_true",
        help="Search the web for each missing-website candidate to raise/lower confidence.",
    )
    parser.add_argument(
        "--search-delay",
        type=float,
        default=1.5,
        help="Seconds to wait between optional search requests.",
    )
    parser.add_argument(
        "--only-likely-no-website",
        action="store_true",
        help="Exclude candidates where search found a possible official website.",
    )
    parser.add_argument("--csv", default="leads.csv", help="CSV output path.")
    parser.add_argument("--json", default="", help="Optional JSON output path.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        categories = normalize_categories(args.categories)
        filters = category_filters(categories)
        bbox = args.bbox or geocode_place(args.place)
        elements = fetch_osm_businesses(bbox, filters)
        leads = make_leads(elements, args.place, args.verify_search, args.search_delay)
        leads = filtered_leads(leads, args.only_likely_no_website)
        leads = leads[: max(0, args.limit)]

        write_csv(Path(args.csv), leads)
        if args.json:
            write_json(Path(args.json), leads)

        print(f"Wrote {len(leads)} leads to {args.csv}")
        if args.json:
            print(f"Wrote JSON to {args.json}")
        if not args.verify_search:
            print("Confidence is medium: these are missing source website tags, not fully verified.")
        return 0
    except (HTTPError, URLError, TimeoutError, ValueError, argparse.ArgumentTypeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
