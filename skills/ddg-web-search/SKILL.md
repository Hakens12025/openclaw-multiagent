---
name: ddg-search
description: Use when web_search is unavailable and you need a no-key web search skill that avoids the built-in web_fetch TLS path by using exec plus a local Python helper.
---

# DuckDuckGo Search via exec

Search the web using DuckDuckGo Lite, fetched through Jina Reader by a local Python helper. This avoids the built-in `web_fetch` path, which may fail on machines where Node HTTPS trust is misconfigured.

## How to Search

Run:

```
python3 ~/.openclaw/skills/ddg-web-search/scripts/search.py "QUERY"
```

Useful flags:

```bash
python3 ~/.openclaw/skills/ddg-web-search/scripts/search.py "QUERY" --region us-en --limit 5
python3 ~/.openclaw/skills/ddg-web-search/scripts/search.py "QUERY" --json
python3 ~/.openclaw/skills/ddg-web-search/scripts/search.py "QUERY" --include-sponsored
```

## Region Filtering

Use `--region REGION`:

- `au-en` — Australia
- `us-en` — United States
- `uk-en` — United Kingdom
- `de-de` — Germany
- `fr-fr` — France

Full list: https://duckduckgo.com/params

## Reading Results

By default, sponsored entries are removed. Each result includes:

- rank
- title
- decoded destination URL
- display domain when available
- snippet text

## Search-then-Fetch Pattern

1. Search:

```bash
python3 ~/.openclaw/skills/ddg-web-search/scripts/search.py "react 19 upgrade guide" --limit 5
```

2. Pick the most relevant URLs from the output.
3. Fetch those pages with `smart-web-fetch`:

```bash
python3 ~/.openclaw/skills/smart-web-fetch/scripts/fetch.py "https://example.com/page" --json
```

## Tips

- For exact phrases, wrap them in quotes inside the query string.
- Add site names, years, or locations to narrow results.
- If you need ads for competitive research, add `--include-sponsored`.

## Limitations

- No reliable time filtering from DDG Lite.
- Results still come from DuckDuckGo/Bing ranking.
- This skill depends on `exec` being available to the agent.
- For page reads, pair it with `smart-web-fetch` instead of built-in `web_fetch`.
