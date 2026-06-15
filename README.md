# Company No-Website Finder

Local CLI for finding businesses that appear not to have a website.

It uses free public sources only:

- Nominatim for place lookup.
- OpenStreetMap Overpass for business records.
- Optional DuckDuckGo HTML search for a lightweight website check.

It does not use Google Places, Yelp, paid APIs, or API keys.

## Usage

```bash
cd /Users/regalia/company-no-website-finder
python3 no_website_finder.py --place "Austin, Texas" --categories plumbers,electricians --csv leads.csv
```

For stronger confidence, enable the search check:

```bash
python3 no_website_finder.py \
  --place "Austin, Texas" \
  --categories plumbers,electricians,cleaning,lawn \
  --verify-search \
  --only-likely-no-website \
  --limit 50 \
  --csv leads.csv \
  --json leads.json
```

## Categories

Valid categories:

- `all`
- `auto`
- `cleaning`
- `contractors`
- `electricians`
- `lawn`
- `plumbers`
- `restaurants`
- `retail`

## Output Meaning

The CSV includes:

- `source_has_website`: always `False` for normal output because the tool filters out records with website tags.
- `official_site_candidate`: set only when `--verify-search` finds a possible official website.
- `no_website_confidence`:
  - `medium`: no website in OpenStreetMap, but web search was not run.
  - `high`: no website in OpenStreetMap and no obvious official site from search.
  - `low`: no website in OpenStreetMap, but search found a possible official site.

This is a lead-generation tool, not proof that a company has no website. Always verify high-value leads manually before outreach.

## Bounding Box Mode

If geocoding is too broad or ambiguous, provide a bounding box:

```bash
python3 no_website_finder.py --bbox "30.10,-97.95,30.52,-97.55" --categories auto --csv auto-leads.csv
```

Bounding box order is `south,west,north,east`.

## Tests

```bash
python3 -m unittest discover -s tests
```
