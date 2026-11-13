#!/usr/bin/env python3
"""Generate adaptive light/dark SVG diagrams and the terminal demo GIF for Turnpack.

Nothing here is typed in by hand where it can be read from a source:
- The GIF runs the built CLI (`node dist/cli.js demo` and `doctor`) and draws what it prints.
- The measured chart, the hero's numbers and the how-it-works headings come from the recorded
  benchmark runs in `bench/results/`, so a picture cannot quote a number the runs do not show.

Run `npm run build` first. Needs Pillow and ffmpeg.
"""
import json
import os
import shutil
import statistics
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"
FRAMES_DIR = Path(os.environ.get("TURNPACK_STAGE_DIR") or tempfile.mkdtemp(prefix="turnpack-assets-")) / "gif-frames"

ASSETS_DIR.mkdir(parents=True, exist_ok=True)
if FRAMES_DIR.exists():
    shutil.rmtree(FRAMES_DIR, ignore_errors=True)
FRAMES_DIR.mkdir(parents=True, exist_ok=True)

PALETTES = {
    "dark": {
        "bg": "#0B0F17",
        "card": "#111827",
        "card2": "#162032",
        "border": "#243044",
        "title": "#F8FAFC",
        "body": "#94A3B8",
        "muted": "#64748B",
        "green": "#10B981",
        "greenBg": "#064E3B",
        "greenText": "#6EE7B7",
        "cyan": "#38BDF8",
        "cyanBg": "#0C4A6E",
        "amber": "#F59E0B",
        "red": "#F43F5E",
        "redBg": "#4C0519",
        "redText": "#FDA4AF",
        "track": "#1E293B",
    },
    "light": {
        "bg": "#F8FAFC",
        "card": "#FFFFFF",
        "card2": "#F1F5F9",
        "border": "#CBD5E1",
        "title": "#0F172A",
        "body": "#475569",
        "muted": "#64748B",
        "green": "#059669",
        "greenBg": "#ECFDF5",
        "greenText": "#047857",
        "cyan": "#0284C7",
        "cyanBg": "#E0F2FE",
        "amber": "#D97706",
        "red": "#E11D48",
        "redBg": "#FFF1F2",
        "redText": "#BE123C",
        "track": "#E2E8F0",
    },
}

FONT_SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

VERSION = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["version"]
MEASURED_FILE = REPO_ROOT / "bench" / "results" / "2026-11-13-claude-code.json"


def load_measured() -> dict:
    """The recorded benchmark runs, with the median of each figure per arm."""
    data = json.loads(MEASURED_FILE.read_text(encoding="utf-8"))
    arms = {}
    for arm in ("native", "prompt", "turnpack"):
        runs = [run for run in data["runs"] if run["arm"] == arm]
        arms[arm] = {
            "runs": len(runs),
            "solved": sum(1 for run in runs if run["solved"]),
            "seconds": statistics.median(run["seconds"] for run in runs),
            "roundTrips": statistics.median(run["roundTrips"] for run in runs),
            "toolCalls": statistics.median(run["toolCalls"] for run in runs),
            "outputTokens": statistics.median(run["outputTokens"] for run in runs),
            "costUsd": statistics.median(run["costUsd"] for run in runs),
        }
    data["arms"] = arms
    return data


MEASURED = load_measured()


def whole(value: float) -> str:
    return f"{int(round(value)):,}"


def less(before: float, after: float) -> str:
    """How much smaller `after` is than `before`, as a whole percentage with a real minus sign."""
    return f"−{round((1 - after / before) * 100)}%"


def measured_rows() -> list[tuple[str, str, str, float, float]]:
    """(label, built-in value, Turnpack value, built-in number, Turnpack number) for each figure."""
    base, tp = MEASURED["arms"]["native"], MEASURED["arms"]["turnpack"]
    return [
        ("MODEL ROUND TRIPS", whole(base["roundTrips"]), whole(tp["roundTrips"]), base["roundTrips"], tp["roundTrips"]),
        ("TIME", f'{base["seconds"]:.1f} s', f'{tp["seconds"]:.1f} s', base["seconds"], tp["seconds"]),
        ("OUTPUT TOKENS", whole(base["outputTokens"]), whole(tp["outputTokens"]), base["outputTokens"], tp["outputTokens"]),
        ("COST", f'${base["costUsd"]:.3f}', f'${tp["costUsd"]:.3f}', base["costUsd"], tp["costUsd"]),
    ]


def write_hero_svg(theme: str) -> None:
    p = PALETTES[theme]
    pills = [
        ("0 API Keys", p["greenBg"], p["greenText"], p["green"]),
        ("0 Dependencies", p["cyanBg"], p["cyan"], p["cyan"]),
        ("100% Local", p["card2"], p["title"], p["border"]),
        ("Auto Rollback on Fail", p["greenBg"], p["greenText"], p["green"]),
        ("MIT License", p["card2"], p["body"], p["border"]),
    ]

    pill_svg = []
    px = 74
    for label, bg_c, txt_c, stroke_c in pills:
        w = int(len(label) * 8.2 + 26)
        pill_svg.append(
            f'<rect x="{px}" y="274" width="{w}" height="34" rx="17" fill="{bg_c}" stroke="{stroke_c}" stroke-width="1"/>'
            f'<text x="{px + w / 2}" y="296" text-anchor="middle" fill="{txt_c}" font-family="{FONT_SANS}" font-size="13" font-weight="600">{label}</text>'
        )
        px += w + 10

    # The three figures people ask about first, straight from the recorded runs.
    labels = {"MODEL ROUND TRIPS": "Round trips", "TIME": "Time", "COST": "Cost"}
    stat_svg = []
    sy = 52
    for label, before, after, before_n, after_n in measured_rows():
        if label not in labels:
            continue
        stat_svg.append(
            f'<rect x="22" y="{sy}" width="202" height="52" rx="10" fill="{p["card2"]}" stroke="{p["border"]}" stroke-width="1"/>'
            f'<text x="36" y="{sy + 21}" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="12.5">{labels[label]}</text>'
            f'<text x="210" y="{sy + 21}" text-anchor="end" fill="{p["green"]}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">{less(before_n, after_n)}</text>'
            f'<text x="36" y="{sy + 42}" font-family="{FONT_MONO}" font-size="15" font-weight="700">'
            f'<tspan fill="{p["muted"]}">{before}</tspan><tspan fill="{p["muted"]}"> → </tspan><tspan fill="{p["greenText"]}">{after}</tspan></text>'
        )
        sy += 62

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 370" width="1200" height="370" role="img" aria-label="Turnpack hero banner">
  <defs>
    <linearGradient id="accentGrad-{theme}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{p['green']}"/>
      <stop offset="100%" stop-color="{p['cyan']}"/>
    </linearGradient>
    <radialGradient id="glow-{theme}" cx="82%" cy="22%" r="45%">
      <stop offset="0%" stop-color="{p['green']}" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="{p['bg']}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="370" rx="22" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>
  <rect width="1200" height="370" rx="22" fill="url(#glow-{theme})"/>

  <!-- Geometric Turnpack Stack Mark -->
  <g transform="translate(74, 54)">
    <rect x="0" y="0" width="54" height="54" rx="14" fill="url(#accentGrad-{theme})"/>
    <rect x="13" y="13" width="28" height="7" rx="3.5" fill="#FFFFFF" opacity="0.95"/>
    <rect x="13" y="24" width="22" height="7" rx="3.5" fill="#FFFFFF" opacity="0.80"/>
    <rect x="13" y="35" width="28" height="7" rx="3.5" fill="#FFFFFF" opacity="0.95"/>
  </g>

  <text x="144" y="80" fill="{p['title']}" font-family="{FONT_SANS}" font-size="24" font-weight="800" letter-spacing="-0.4">turnpack</text>
  <text x="144" y="102" fill="{p['green']}" font-family="{FONT_MONO}" font-size="13" font-weight="700">v{VERSION}  ·  LOCAL MCP  ·  CLAUDE CODE · CODEX · CHATGPT · OMP · GROK</text>

  <text x="74" y="172" fill="{p['title']}" font-family="{FONT_SANS}" font-size="36" font-weight="800" letter-spacing="-0.8">Edits that are tested before they stay.</text>
  <text x="74" y="212" fill="{p['body']}" font-family="{FONT_SANS}" font-size="18.5" font-weight="400">One call reads what your agent needs. One call edits across files and runs</text>
  <text x="74" y="240" fill="{p['body']}" font-family="{FONT_SANS}" font-size="18.5" font-weight="400">your tests. If they fail, every file goes back exactly as it was.</text>

  {"".join(pill_svg)}

  <!-- Right-side box: the measured run -->
  <g transform="translate(888, 52)">
    <rect x="0" y="0" width="246" height="266" rx="16" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.2"/>
    <text x="22" y="34" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">MEASURED, NOT MODELED</text>
    {"".join(stat_svg)}
    <text x="123" y="252" text-anchor="middle" fill="{p['muted']}" font-family="{FONT_SANS}" font-size="10.5">{MEASURED['app']} · one task · 3 runs each</text>
  </g>
</svg>
"""
    (ASSETS_DIR / f"hero-{theme}.svg").write_text(svg, encoding="utf-8")


def write_measured_svg(theme: str) -> None:
    """The headline result: the same task with and without Turnpack, drawn from the recorded runs."""
    p = PALETTES[theme]
    base, tp, asked = MEASURED["arms"]["native"], MEASURED["arms"]["turnpack"], MEASURED["arms"]["prompt"]
    card_w, gap, left = 266, 16, 44
    bar_w = card_w - 44

    cards = []
    x = left
    for label, before, after, before_n, after_n in measured_rows():
        after_w = max(10, round(bar_w * after_n / before_n))
        cards.append(
            f'<rect x="{x}" y="112" width="{card_w}" height="252" rx="14" fill="{p["card"]}" stroke="{p["border"]}" stroke-width="1.2"/>'
            f'<text x="{x + 22}" y="144" fill="{p["muted"]}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">{label}</text>'
            f'<text x="{x + 22}" y="204" fill="{p["green"]}" font-family="{FONT_SANS}" font-size="52" font-weight="800" letter-spacing="-1.5">{less(before_n, after_n)}</text>'
            # built-in tools
            f'<text x="{x + 22}" y="246" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="13">Built-in tools</text>'
            f'<text x="{x + 22 + bar_w}" y="246" text-anchor="end" fill="{p["title"]}" font-family="{FONT_MONO}" font-size="14" font-weight="700">{before}</text>'
            f'<rect x="{x + 22}" y="255" width="{bar_w}" height="14" rx="4" fill="{p["muted"]}" opacity="0.55"/>'
            # with Turnpack
            f'<text x="{x + 22}" y="306" fill="{p["greenText"]}" font-family="{FONT_SANS}" font-size="13" font-weight="600">With Turnpack</text>'
            f'<text x="{x + 22 + bar_w}" y="306" text-anchor="end" fill="{p["greenText"]}" font-family="{FONT_MONO}" font-size="14" font-weight="700">{after}</text>'
            f'<rect x="{x + 22}" y="315" width="{bar_w}" height="14" rx="4" fill="{p["track"]}"/>'
            f'<rect x="{x + 22}" y="315" width="{after_w}" height="14" rx="4" fill="{p["green"]}"/>'
        )
        x += card_w + gap

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 470" width="1200" height="470" role="img" aria-label="Measured: the same task with and without Turnpack">
  <rect width="1200" height="470" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <text x="44" y="52" fill="{p['title']}" font-family="{FONT_SANS}" font-size="24" font-weight="800">Measured: the same task, with and without Turnpack</text>
  <text x="44" y="80" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14.5">Rename a function used in five files, then make the tests pass. {MEASURED['app']} {MEASURED['appVersion']} with {MEASURED['model']}, median of {base['runs']} runs each, nothing in the prompt about Turnpack.</text>

  {"".join(cards)}

  <rect x="44" y="384" width="1112" height="56" rx="12" fill="{p['card2']}" stroke="{p['border']}" stroke-width="1"/>
  <text x="64" y="408" fill="{p['title']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">The built-in tools were already batching: {whole(base['toolCalls'])} tool calls in {whole(base['roundTrips'])} round trips. Turnpack: {whole(tp['toolCalls'])} tool calls in {whole(tp['roundTrips'])}.</text>
  <text x="64" y="428" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13">Asked to batch harder, they took {whole(asked['roundTrips'])} round trips and {asked['seconds']:.1f} s. The gain is in the steps that depend on each other: search then read, edit then test.</text>
  <text x="1136" y="418" text-anchor="end" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">npm run bench:agents</text>
</svg>
"""
    (ASSETS_DIR / f"measured-{theme}.svg").write_text(svg, encoding="utf-8")


def write_how_it_works_svg(theme: str) -> None:
    """Both columns are the calls of recorded runs, not an illustration.

    Left: runs 2 and 3 of the built-in arm (run 1 searched twice and edited without reading).
    Right: every Turnpack run was the same two calls.
    """
    p = PALETTES[theme]
    base, tp = MEASURED["arms"]["native"], MEASURED["arms"]["turnpack"]
    trips = [
        ("Trip 1", "Search for calculateTax", "1 call"),
        ("Trip 2", "Read the 5 files it found", "5 calls"),
        ("Trip 3", "Edit the 5 files, one call per file", "5 calls"),
        ("Trip 4", "Read package.json to find the test command", "1 call"),
        ("Trip 5", "Run npm test", "1 call"),
        ("Trip 6", "Report back", ""),
    ]

    left_rows = []
    y = 122
    for tag, desc, count in trips:
        left_rows.append(
            f'<rect x="64" y="{y}" width="492" height="44" rx="9" fill="{p["track"]}" stroke="{p["border"]}" stroke-width="1"/>'
            f'<text x="82" y="{y + 27}" fill="{p["muted"]}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">{tag}</text>'
            f'<text x="150" y="{y + 27}" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="14" font-weight="600">{desc}</text>'
            f'<text x="538" y="{y + 27}" text-anchor="end" fill="{p["muted"]}" font-family="{FONT_MONO}" font-size="12">{count}</text>'
        )
        y += 53
    left_rows.append(
        f'<rect x="64" y="{y}" width="492" height="44" rx="9" fill="{p["redBg"]}" stroke="{p["red"]}" stroke-width="1"/>'
        f'<text x="82" y="{y + 27}" fill="{p["redText"]}" font-family="{FONT_SANS}" font-size="13.5" font-weight="600">Had the tests failed at trip 5, five files were already changed.</text>'
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 525" width="1200" height="525" role="img" aria-label="The same rename task: six round trips with built-in tools, three with Turnpack">
  <rect width="1200" height="525" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <!-- Left card: the built-in tools -->
  <rect x="34" y="30" width="552" height="465" rx="16" fill="{p['card']}" stroke="{p['border']}" stroke-width="1.2"/>
  <rect x="64" y="54" width="142" height="26" rx="13" fill="{p['card2']}" stroke="{p['border']}" stroke-width="1"/>
  <text x="135" y="72" text-anchor="middle" fill="{p['body']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">BUILT-IN TOOLS</text>
  <text x="64" y="106" fill="{p['title']}" font-family="{FONT_SANS}" font-size="21" font-weight="700">{whole(base['roundTrips'])} round trips · {whole(base['toolCalls'])} tool calls · {base['seconds']:.1f} s</text>
  {"".join(left_rows)}

  <!-- Arrow Badge Center -->
  <circle cx="600" cy="262" r="24" fill="{p['green']}" stroke="{p['bg']}" stroke-width="4"/>
  <text x="600" y="269" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_SANS}" font-size="22" font-weight="800">→</text>

  <!-- Right card: with Turnpack -->
  <rect x="614" y="30" width="552" height="465" rx="16" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.5"/>
  <rect x="644" y="54" width="166" height="26" rx="13" fill="{p['greenBg']}" stroke="{p['green']}" stroke-width="1"/>
  <text x="727" y="72" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">WITH TURNPACK</text>
  <text x="644" y="106" fill="{p['title']}" font-family="{FONT_SANS}" font-size="21" font-weight="700">{whole(tp['roundTrips'])} round trips · {whole(tp['toolCalls'])} tool calls · {tp['seconds']:.1f} s</text>

  <!-- Trip 1 -->
  <rect x="644" y="122" width="492" height="146" rx="14" fill="{p['card2']}" stroke="{p['cyan']}" stroke-width="1.2"/>
  <rect x="664" y="138" width="118" height="24" rx="6" fill="{p['cyanBg']}"/>
  <text x="723" y="154" text-anchor="middle" fill="{p['cyan']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">TRIP 1 · pack</text>
  <text x="796" y="155" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">does the work of trips 1, 2 and 4</text>
  <text x="664" y="186" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">The search comes back with the code around each hit</text>
  <text x="664" y="212" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• One call found all 5 files and showed the lines that matter</text>
  <text x="664" y="234" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• The server had already named the test command: npm test</text>
  <text x="664" y="256" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• .env and key files are redacted, and the reply is size-capped</text>

  <!-- Trip 2 -->
  <rect x="644" y="280" width="492" height="158" rx="14" fill="{p['card2']}" stroke="{p['green']}" stroke-width="1.2"/>
  <rect x="664" y="296" width="118" height="24" rx="6" fill="{p['greenBg']}"/>
  <text x="723" y="312" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">TRIP 2 · ship</text>
  <text x="796" y="313" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">does the work of trips 3 and 5</text>
  <text x="664" y="344" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">9 edits in 5 files and npm test, in one call</text>
  <text x="664" y="370" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Every edit is checked before anything is written to disk</text>
  <text x="664" y="392" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Then the tests run, in the same call</text>
  <rect x="664" y="402" width="452" height="26" rx="7" fill="{p['greenBg']}"/>
  <text x="678" y="420" fill="{p['greenText']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">Tests pass → SHIPPED   |   Tests fail → every file put back as it was</text>

  <!-- Trip 3 -->
  <rect x="644" y="448" width="492" height="34" rx="9" fill="{p['track']}" stroke="{p['border']}" stroke-width="1"/>
  <text x="662" y="470" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">Trip 3</text>
  <text x="730" y="470" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14" font-weight="600">Report back</text>
</svg>
"""
    (ASSETS_DIR / f"how-it-works-{theme}.svg").write_text(svg, encoding="utf-8")


def write_ttft_tax_svg(theme: str) -> None:
    p = PALETTES[theme]
    # 16 mini repeating [TTFT | Stream] blocks for Normal loop vs 4 blocks for Turnpack
    loop16_svg = []
    bx = 58
    for i in range(16):
        loop16_svg.append(
            f'<rect x="{bx}" y="318" width="24" height="32" rx="4" fill="{p["red"]}" opacity="0.88"/>'
            f'<rect x="{bx + 26}" y="318" width="30" height="32" rx="4" fill="{p["amber"]}" opacity="0.82"/>'
        )
        bx += 60

    loop4_svg = []
    tx = 58
    for i in range(4):
        loop4_svg.append(
            f'<rect x="{tx}" y="396" width="24" height="32" rx="4" fill="{p["red"]}" opacity="0.88"/>'
            f'<rect x="{tx + 26}" y="396" width="30" height="32" rx="4" fill="{p["amber"]}" opacity="0.82"/>'
        )
        tx += 60

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 490" width="1200" height="490" role="img" aria-label="TTFT and slow token streaming tax across 16 tool calls vs 4 Turnpack calls">
  <rect width="1200" height="490" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <text x="58" y="48" fill="{p['title']}" font-family="{FONT_SANS}" font-size="23.5" font-weight="800">Why AI Tool Loops Feel Slow: Cloud TTFT + Repeated Token Streams</text>
  <text x="58" y="74" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14.5">Even when reading a file takes 0.02s on disk, every separate tool call triggers another full model generation turn:</text>

  <!-- Section A: Anatomy of ONE Tool Call -->
  <rect x="44" y="94" width="1112" height="148" rx="14" fill="{p['card']}" stroke="{p['border']}" stroke-width="1.2"/>
  <text x="64" y="120" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">ANATOMY OF ONE INTERMEDIATE AI TOOL CALL</text>

  <rect x="64" y="132" width="446" height="42" rx="8" fill="{p['red']}" opacity="0.85"/>
  <text x="287" y="158" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">1. Cloud TTFT Freeze: 2s–25s+  (Local Warm KV: &lt;1s)</text>

  <rect x="514" y="132" width="538" height="42" rx="8" fill="{p['amber']}" opacity="0.86"/>
  <text x="783" y="158" text-anchor="middle" fill="#0B0F17" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">2. Thinking &amp; Token Stream (18–45 tok/s): 5s–25s+</text>

  <rect x="1056" y="132" width="80" height="42" rx="8" fill="{p['green']}"/>
  <text x="1096" y="158" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_MONO}" font-size="12" font-weight="700">0.02s tool</text>

  <circle cx="72" cy="196" r="5" fill="{p['red']}"/>
  <text x="84" y="201" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13">Cloud TTFT: API queues, cold-cache routers &amp; deep-thinking prefill (2s–25s+). Dedicated local GPUs hit &lt;1s TTFT.</text>
  <circle cx="72" cy="218" r="5" fill="{p['amber']}"/>
  <text x="84" y="223" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13">Token Stream (Cloud &amp; Local): 225–450+ reasoning/tool tokens generated per step — plus raw dumps bloat VRAM KV cache.</text>

  <!-- Section B: 16 Calls vs 4 Calls -->
  <text x="58" y="284" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Example: one tool call per turn — 16 round trips</text>
  <text x="1142" y="284" text-anchor="end" fill="{p['red']}" font-family="{FONT_MONO}" font-size="13" font-weight="700">16 × (TTFT + token stream) of waiting</text>
  <rect x="52" y="308" width="1096" height="52" rx="10" fill="{p['card']}" stroke="{p['border']}" stroke-width="1"/>
  {"".join(loop16_svg)}
  <text x="1030" y="339" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">16× PAID</text>

  <text x="58" y="378" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Same task as 4 bundled calls (pack + ship)</text>
  <rect x="52" y="390" width="1096" height="44" rx="10" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.3"/>
  {"".join(loop4_svg)}
  <rect x="308" y="396" width="832" height="32" rx="6" fill="{p['greenBg']}"/>
  <text x="724" y="417" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">12 round trips that never happen: no TTFT, no token stream, less context used</text>

  <text x="58" y="466" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">Illustration, not a measurement. Red = TTFT per call · Amber = token stream per call · Green = round trips avoided</text>
</svg>
"""
    (ASSETS_DIR / f"ttft-tax-{theme}.svg").write_text(svg, encoding="utf-8")


def write_time_saved_svg(theme: str) -> None:
    p = PALETTES[theme]
    rows = [
        ("Local GPU · Warm KV", "0.5s TTFT + 11s gen = 11.5s", 184, 46, "3m 04s", "46s", "Save ~2m 18s / task"),
        ("Fast Warm Cloud API", "2s TTFT + 5s stream = 7s", 112, 28, "1m 52s", "28s", "Save ~1m 24s / task"),
        ("Frontier Cloud Reasoning", "6s TTFT + 12s stream = 18s", 288, 72, "4m 48s", "1m 12s", "Save ~3m 36s / task"),
        ("Busy / High-TTFT Cloud", "15s TTFT + 20s stream = 35s", 560, 140, "9m 20s", "2m 20s", "Save ~7m 00s / task"),
        ("Cold-Cache Cloud / Max-Think", "25s TTFT + 25s stream = 50s", 800, 200, "13m 20s", "3m 20s", "Save ~10m 00s / task"),
    ]

    bars_svg = []
    y = 114
    max_bar = 370
    max_sec = 800
    for title, sub, base_sec, tp_sec, base_lbl, tp_lbl, save_lbl in rows:
        base_w = max(24, int((base_sec / max_sec) * max_bar))
        tp_w = max(14, int((tp_sec / max_sec) * max_bar))
        bars_svg.append(
            f'<text x="58" y="{y}" fill="{p["title"]}" font-family="{FONT_SANS}" font-size="14.5" font-weight="700">{title} '
            f'<tspan fill="{p["muted"]}" font-family="{FONT_MONO}" font-size="11.5" font-weight="500">({sub})</tspan></text>'
            f'<text x="708" y="{y}" text-anchor="end" fill="{p["green"]}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">{save_lbl}</text>'
            f'<rect x="58" y="{y + 10}" width="{max_bar}" height="20" rx="5" fill="{p["track"]}"/>'
            f'<rect x="58" y="{y + 10}" width="{base_w}" height="20" rx="5" fill="{p["red"]}" opacity="0.76"/>'
            f'<text x="{58 + max_bar + 14}" y="{y + 25}" fill="{p["body"]}" font-family="{FONT_MONO}" font-size="12">Normal 16t: ~{base_lbl}</text>'
            f'<rect x="58" y="{y + 35}" width="{max_bar}" height="20" rx="5" fill="{p["track"]}"/>'
            f'<rect x="58" y="{y + 35}" width="{tp_w}" height="20" rx="5" fill="{p["green"]}"/>'
            f'<text x="{58 + max_bar + 14}" y="{y + 50}" fill="{p["greenText"]}" font-family="{FONT_MONO}" font-size="12" font-weight="700">Turnpack 4t: ~{tp_lbl}</text>'
        )
        y += 96

    weekly_rows = [
        ("Local GPU · 0.5s TTFT (11.5s/t)", "~3.8 hrs / wk", p["cyan"]),
        ("Fast Warm Cloud API (7s/t)", "~2.3 hrs / wk", p["body"]),
        ("Frontier Cloud (18s/t)", "~6.0 hrs / wk", p["title"]),
        ("Busy / High-TTFT Cloud (35s/t)", "~11.7 hrs / wk", p["greenText"]),
        ("Cold-Cache / Max-Think (50s/t)", "~16.7 hrs / wk", p["green"]),
    ]
    wk_svg = []
    wy = 190
    for lbl, hrs, clr in weekly_rows:
        wk_svg.append(
            f'<rect x="762" y="{wy}" width="366" height="42" rx="9" fill="{p["card2"]}" stroke="{p["border"]}" stroke-width="1"/>'
            f'<text x="778" y="{wy + 26}" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="13" font-weight="600">{lbl}</text>'
            f'<text x="1112" y="{wy + 26}" text-anchor="end" fill="{clr}" font-family="{FONT_MONO}" font-size="13.5" font-weight="700">{hrs}</text>'
        )
        wy += 50

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 640" width="1200" height="640" role="img" aria-label="Time saved across Local GPU warm KV cache and Cloud TTFT speeds">
  <rect width="1200" height="640" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <text x="58" y="48" fill="{p['title']}" font-family="{FONT_SANS}" font-size="24" font-weight="800">Modeled Waiting Time: a 16-Round-Trip Task Done in 4</text>
  <text x="58" y="74" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14.5">A model, not a benchmark: round trips avoided × your per-turn latency. Your turn counts will differ, so plug in your own.</text>

  {"".join(bars_svg)}

  <!-- Weekly Impact Highlight Box -->
  <rect x="738" y="102" width="414" height="474" rx="16" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.4"/>
  <rect x="762" y="124" width="366" height="28" rx="14" fill="{p['greenBg']}"/>
  <text x="945" y="143" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">MODELED HOURS / WEEK (20 tasks/day · 5d/wk)</text>
  <text x="762" y="174" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13.5">If each task really drops 12 round trips:</text>

  {"".join(wk_svg)}

  <text x="762" y="468" fill="{p['title']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">+ Built for Local GPUs &amp; Cloud alike:</text>
  <text x="762" y="490" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">• Local GPU: ~1.3k-token tool schema, bounded replies</text>
  <text x="762" y="510" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">• Cloud API: skips cold-cache 100k+ prefill &amp; queues</text>
  <text x="762" y="530" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">• Both: skips 12× token streams &amp; broken half-edits</text>

  <text x="58" y="612" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">Formula: turns_saved × (TTFT + tokens_per_turn ÷ tok/s). Use your own numbers: npx turnpack estimate</text>
</svg>
"""
    (ASSETS_DIR / f"time-saved-{theme}.svg").write_text(svg, encoding="utf-8")


def write_social_preview_svg() -> None:
    """1280x640 card for link previews. Rasterize it to PNG and upload it under the repository's
    Settings -> Social preview; GitHub does not accept SVG there."""
    p = PALETTES["dark"]
    tools = [
        ("pack", p["cyan"], "Search, with the code", "around every hit"),
        ("ship", p["green"], "Edit, test, and undo", "if the tests fail"),
        ("batch", p["amber"], "One read-only script", "instead of 40 reads"),
    ]
    base, tp = MEASURED["arms"]["native"], MEASURED["arms"]["turnpack"]
    social_stat = (
        f'{whole(base["roundTrips"])} → {whole(tp["roundTrips"])} round trips'
        f' · {round((1 - tp["seconds"] / base["seconds"]) * 100)}% faster'
        f' · {round((1 - tp["costUsd"] / base["costUsd"]) * 100)}% cheaper'
    )
    cards = []
    x = 80
    for name, color, line1, line2 in tools:
        cards.append(
            f'<rect x="{x}" y="372" width="352" height="124" rx="16" fill="{p["card"]}" stroke="{p["border"]}" stroke-width="1.5"/>'
            f'<text x="{x + 26}" y="414" fill="{color}" font-family="{FONT_MONO}" font-size="24" font-weight="700">{name}</text>'
            f'<text x="{x + 26}" y="448" fill="{p["title"]}" font-family="{FONT_SANS}" font-size="20" font-weight="600">{line1}</text>'
            f'<text x="{x + 26}" y="474" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="18">{line2}</text>'
        )
        x += 384

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640" role="img" aria-label="Turnpack: fewer back-and-forth AI turns">
  <defs>
    <linearGradient id="social-accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{p['green']}"/>
      <stop offset="100%" stop-color="{p['cyan']}"/>
    </linearGradient>
    <radialGradient id="social-glow" cx="85%" cy="12%" r="55%">
      <stop offset="0%" stop-color="{p['green']}" stop-opacity="0.20"/>
      <stop offset="100%" stop-color="{p['bg']}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1280" height="640" fill="{p['bg']}"/>
  <rect width="1280" height="640" fill="url(#social-glow)"/>

  <g transform="translate(80, 64)">
    <rect x="0" y="0" width="64" height="64" rx="16" fill="url(#social-accent)"/>
    <rect x="15" y="15" width="34" height="8" rx="4" fill="#FFFFFF" opacity="0.95"/>
    <rect x="15" y="28" width="26" height="8" rx="4" fill="#FFFFFF" opacity="0.80"/>
    <rect x="15" y="41" width="34" height="8" rx="4" fill="#FFFFFF" opacity="0.95"/>
  </g>
  <text x="164" y="108" fill="{p['title']}" font-family="{FONT_SANS}" font-size="38" font-weight="800" letter-spacing="-0.6">turnpack</text>

  <text x="80" y="218" fill="{p['title']}" font-family="{FONT_SANS}" font-size="58" font-weight="800" letter-spacing="-1.6">Edits that are tested</text>
  <text x="80" y="286" fill="{p['title']}" font-family="{FONT_SANS}" font-size="58" font-weight="800" letter-spacing="-1.6">before they stay.</text>
  <text x="80" y="334" fill="{p['body']}" font-family="{FONT_SANS}" font-size="25">A local MCP server for AI coding agents. Tests fail? Every file goes back.</text>

  {"".join(cards)}

  <rect x="80" y="536" width="322" height="50" rx="12" fill="{p['greenBg']}" stroke="{p['green']}" stroke-width="1.2"/>
  <text x="104" y="569" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="22" font-weight="700">npx turnpack demo</text>
  <text x="1200" y="560" text-anchor="end" fill="{p['title']}" font-family="{FONT_SANS}" font-size="20" font-weight="700">{social_stat}</text>
  <text x="1200" y="586" text-anchor="end" fill="{p['muted']}" font-family="{FONT_SANS}" font-size="16" font-weight="600">Measured on one task in {MEASURED['app']} · no API keys · zero dependencies</text>
</svg>
"""
    (ASSETS_DIR / "social-preview.svg").write_text(svg, encoding="utf-8")


def load_font(size: int, mono: bool = False):
    candidates = (
        ["C:/Windows/Fonts/consolab.ttf", "C:/Windows/Fonts/consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
        if mono
        else ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    )
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def capture_cli(*args: str) -> list[str]:
    """Run the built CLI and return its output lines exactly as a user would see them."""
    env = {**os.environ, "NO_COLOR": "1"}
    for key in ("TURNPACK_ROOT", "CLAUDE_PROJECT_DIR", "TURNPACK_ALLOW_EXEC"):
        env.pop(key, None)
    cli = REPO_ROOT / "dist" / "cli.js"
    if not cli.exists():
        raise SystemExit("dist/cli.js not found: run `npm run build` before rendering assets")
    # The CLI writes UTF-8. Without saying so, Windows decodes it as the system code page and
    # the box-drawing rules come out as mojibake.
    done = subprocess.run(["node", str(cli), *args], check=True, capture_output=True, text=True, encoding="utf-8", env=env)
    return [line.rstrip() for line in done.stdout.strip("\n").split("\n")]


def capture_doctor() -> list[str]:
    """`doctor` as a new user sees it right after `init`.

    Run against the maintainer's own machine, doctor would list whichever AI apps happen to be
    installed there. So the recording uses a temporary home directory in which five apps exist,
    lets the real `init` configure them, and then runs the real `doctor` on it. Every line is
    still the CLI's own output.
    """
    cli = REPO_ROOT / "dist" / "cli.js"
    with tempfile.TemporaryDirectory(prefix="turnpack-assets-home-") as home_dir:
        home = Path(home_dir)
        if os.name == "nt":
            desktop = home / "AppData" / "Roaming" / "Claude"
        elif os.uname().sysname == "Darwin":
            desktop = home / "Library" / "Application Support" / "Claude"
        else:
            desktop = home / ".config" / "Claude"
        for folder in (home / ".claude", home / ".codex", home / ".omp", home / ".grok", desktop):
            folder.mkdir(parents=True)
        subprocess.run(
            ["node", str(cli), "init", "--yes", "--home", str(home)],
            check=True,
            capture_output=True,
            text=True,
        )
        return capture_cli("doctor", "--home", str(home))


def line_color(line: str) -> str:
    stripped = line.strip()
    if not stripped:
        return "#94A3B8"
    if set(stripped) == {"─"}:
        return "#334155"
    if "FAIL" in stripped:
        return "#FDA4AF"
    if stripped.startswith("->"):
        return "#6EE7B7"
    if stripped.startswith("[ok"):
        return "#6EE7B7"
    if stripped.startswith("[warn"):
        return "#FDE68A"
    if "passed" in stripped:
        return "#10B981"
    if stripped.startswith("turnpack"):
        return "#F8FAFC"
    return "#CBD5E1"


def render_demo_gif() -> None:
    width = 960
    line_height = 27
    f_mono = load_font(16, mono=True)
    f_title = load_font(15, mono=False)

    demo_lines = capture_cli("demo")
    doctor_lines = capture_doctor()
    # Tall enough for the longer of the two outputs, and never shorter than the original frame.
    height = max(600, 78 + line_height + 6 + line_height * max(len(demo_lines), len(doctor_lines)) + 30)

    # Reveal the demo two lines at a time (each tool prints a "did" line and a "->" result line).
    header = 2
    demo_reveals = [demo_lines[: header + 2 * n] for n in range(1, 6)] + [demo_lines]
    # Open on the finished demo, so a paused or not-yet-animating GIF still shows the result.
    scenes = [
        {"cmd": "$ npx turnpack demo", "lines": demo_lines, "hold": 14, "type": False},
        {"cmd": "$ npx turnpack demo", "lines": [], "hold": 4, "type": True},
    ]
    for shown in demo_reveals[:-1]:
        scenes.append({"cmd": "$ npx turnpack demo", "lines": shown, "hold": 9, "type": False})
    scenes.append({"cmd": "$ npx turnpack demo", "lines": demo_lines, "hold": 34, "type": False})
    scenes.append({"cmd": "$ npx turnpack doctor", "lines": [], "hold": 4, "type": True})
    scenes.append({"cmd": "$ npx turnpack doctor", "lines": doctor_lines, "hold": 40, "type": False})

    frame_idx = 0
    for scene in scenes:
        cmd_text = scene["cmd"]
        cuts = [2, 8, 14, len(cmd_text)] if scene["type"] else [len(cmd_text)]
        for cut in cuts:
            img = Image.new("RGB", (width, height), "#090D16")
            draw = ImageDraw.Draw(img)
            draw.rounded_rectangle([20, 16, width - 20, height - 16], radius=16, fill="#0F172A", outline="#1E293B", width=2)
            draw.rounded_rectangle([20, 16, width - 20, 58], radius=16, fill="#162033")
            draw.rectangle([20, 44, width - 20, 58], fill="#162033")
            draw.ellipse([40, 30, 52, 42], fill="#EF4444")
            draw.ellipse([60, 30, 72, 42], fill="#F59E0B")
            draw.ellipse([80, 30, 92, 42], fill="#10B981")
            draw.text((116, 28), "turnpack — real output of the commands shown", fill="#94A3B8", font=f_title)

            typed = cut < len(cmd_text)
            draw.text((44, 78), cmd_text[:cut] + ("▌" if typed else ""), fill="#F8FAFC", font=f_mono)

            if not typed:
                ly = 78 + line_height + 6
                for line in scene["lines"]:
                    draw.text((44, ly), line, fill=line_color(line), font=f_mono)
                    ly += line_height
                repeats = scene["hold"]
            else:
                repeats = 2

            for _ in range(repeats):
                img.save(FRAMES_DIR / f"frame_{frame_idx:04d}.png")
                frame_idx += 1

    palette_path = FRAMES_DIR / "palette.png"
    out_gif = ASSETS_DIR / "demo.gif"
    subprocess.run(
        ["ffmpeg", "-y", "-framerate", "10", "-i", str(FRAMES_DIR / "frame_%04d.png"), "-vf", "palettegen=stats_mode=diff", str(palette_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(
        ["ffmpeg", "-y", "-framerate", "10", "-i", str(FRAMES_DIR / "frame_%04d.png"), "-i", str(palette_path), "-lavfi", "paletteuse=dither=none", str(out_gif)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    shutil.rmtree(FRAMES_DIR, ignore_errors=True)
    print(f"Rendered SVGs and demo.gif ({out_gif.stat().st_size} bytes)")


if __name__ == "__main__":
    for th in ("dark", "light"):
        write_hero_svg(th)
        write_measured_svg(th)
        write_how_it_works_svg(th)
        write_ttft_tax_svg(th)
        write_time_saved_svg(th)
    write_social_preview_svg()
    render_demo_gif()
