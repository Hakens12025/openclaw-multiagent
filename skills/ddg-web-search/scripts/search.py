#!/usr/bin/env python3
"""
DuckDuckGo Lite search helper for OpenClaw.

Fetches search results through Jina Reader so it does not depend on the
broken built-in web_fetch TLS path in this environment.
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from typing import List, Optional


USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
JINA_PREFIX = "https://r.jina.ai/http://"
TITLE_RE = re.compile(r"^(\d+)\.\[(.+?)\]\((.+?)\)(?:\s+\(Sponsored link.*)?$")
MARKDOWN_HEADER = "Markdown Content:"


ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE


@dataclass
class SearchResult:
    rank: int
    title: str
    url: str
    display_url: Optional[str]
    snippet: str
    sponsored: bool


def build_search_url(query: str, region: Optional[str]) -> str:
    params = {"q": query}
    if region:
        params["kl"] = region
    return f"https://lite.duckduckgo.com/lite/?{urllib.parse.urlencode(params)}"


def jina_url(url: str) -> str:
    cleaned = url.replace("https://", "").replace("http://", "", 1)
    return f"{JINA_PREFIX}{cleaned}"


def fetch_text(url: str, timeout: int) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/markdown, text/plain;q=0.9, */*;q=0.1",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
        return response.read().decode("utf-8", errors="ignore")


def strip_markdown(text: str) -> str:
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"\[(.*?)\]\([^)]+\)", r"\1", text)
    text = text.replace("`", "")
    return " ".join(text.split()).strip()


def decode_ddg_redirect(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        uddg = params.get("uddg")
        if uddg and uddg[0]:
            return urllib.parse.unquote(uddg[0])
    except Exception:
        pass
    return url


def looks_like_display_url(line: str) -> bool:
    if " " in line:
        return False
    if line.startswith("http://") or line.startswith("https://"):
        return True
    return "." in line and "/" not in line


def extract_markdown_body(raw: str) -> str:
    marker_index = raw.find(MARKDOWN_HEADER)
    if marker_index == -1:
        return raw
    return raw[marker_index + len(MARKDOWN_HEADER):].strip()


def finalize_result(current: Optional[dict], results: List[SearchResult]) -> None:
    if not current:
        return

    body_lines = [line for line in current["lines"] if line]
    display_url = None
    if body_lines and looks_like_display_url(body_lines[-1]):
        display_url = body_lines.pop()

    snippet = strip_markdown(" ".join(body_lines))
    result = SearchResult(
        rank=current["rank"],
        title=strip_markdown(current["title"]),
        url=decode_ddg_redirect(current["url"]),
        display_url=display_url,
        snippet=snippet,
        sponsored=current["sponsored"],
    )
    results.append(result)


def parse_results(raw: str, include_sponsored: bool) -> List[SearchResult]:
    body = extract_markdown_body(raw)
    lines = [line.rstrip() for line in body.splitlines()]

    results: List[SearchResult] = []
    current = None
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("![Image "):
            break

        match = TITLE_RE.match(stripped)
        if match:
            finalize_result(current, results)
            rank = int(match.group(1))
            title = match.group(2)
            url = match.group(3)
            sponsored = "Sponsored link" in stripped
            current = {
                "rank": rank,
                "title": title,
                "url": url,
                "sponsored": sponsored,
                "lines": [],
            }
            continue

        if current is not None:
            current["lines"].append(stripped)

    finalize_result(current, results)
    if include_sponsored:
        return results
    return [item for item in results if not item.sponsored]


def render_text(query: str, search_url: str, source_url: str, results: List[SearchResult]) -> str:
    lines = [
        f"Query: {query}",
        f"Search URL: {search_url}",
        f"Fetched via: {source_url}",
        "",
    ]

    if not results:
        lines.append("No results found.")
        return "\n".join(lines)

    for item in results:
        lines.append(f"{item.rank}. {item.title}")
        lines.append(f"   URL: {item.url}")
        if item.display_url:
            lines.append(f"   Display: {item.display_url}")
        if item.snippet:
            lines.append(f"   Snippet: {item.snippet}")
        if item.sponsored:
            lines.append("   Sponsored: yes")
        lines.append("")

    return "\n".join(lines).rstrip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DuckDuckGo Lite search via Jina Reader")
    parser.add_argument("query", help="Search query text")
    parser.add_argument("--region", help="DuckDuckGo kl region, e.g. us-en")
    parser.add_argument("--limit", type=int, default=8, help="Maximum number of results to print")
    parser.add_argument("--include-sponsored", action="store_true", help="Keep sponsored results in output")
    parser.add_argument("--timeout", type=int, default=30, help="Fetch timeout in seconds")
    parser.add_argument("--json", action="store_true", help="Print JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    search_url = build_search_url(args.query, args.region)
    source_url = jina_url(search_url)

    try:
        raw = fetch_text(source_url, args.timeout)
        results = parse_results(raw, include_sponsored=args.include_sponsored)
        limited = results[: max(1, args.limit)]
    except Exception as exc:
        if args.json:
            print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        else:
            print(f"Error: {exc}", file=sys.stderr)
        return 1

    payload = {
        "success": True,
        "query": args.query,
        "search_url": search_url,
        "fetched_via": source_url,
        "result_count": len(limited),
        "results": [asdict(item) for item in limited],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(render_text(args.query, search_url, source_url, limited))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
