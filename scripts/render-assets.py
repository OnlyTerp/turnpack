#!/usr/bin/env python3
"""Generate adaptive light/dark SVG diagrams and the terminal demo GIF for Turnpack.

The GIF is not hand-written: it runs the built CLI (`node dist/cli.js demo` and `doctor`) and
draws whatever those commands print, so the picture in the README cannot drift from the tool.
Run `npm run build` first. Needs Pillow and ffmpeg.
"""
import os
import shutil
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
  <text x="144" y="102" fill="{p['green']}" font-family="{FONT_MONO}" font-size="13" font-weight="700">v0.1.0  ·  LOCAL MCP FOR CLAUDE CODE · CODEX · OMP · CURSOR</text>

  <text x="74" y="172" fill="{p['title']}" font-family="{FONT_SANS}" font-size="36" font-weight="800" letter-spacing="-0.8">Stop watching your AI read one file at a time.</text>
  <text x="74" y="212" fill="{p['body']}" font-family="{FONT_SANS}" font-size="18.5" font-weight="400">Turnpack bundles search &amp; file reading into one clean step — and applies multi-file</text>
  <text x="74" y="240" fill="{p['body']}" font-family="{FONT_SANS}" font-size="18.5" font-weight="400">edits only if your tests pass. If a test fails, every file rewinds automatically.</text>

  {"".join(pill_svg)}

  <!-- Right-side compact summary box -->
  <g transform="translate(888, 52)">
    <rect x="0" y="0" width="246" height="256" rx="16" fill="{p['card']}" stroke="{p['border']}" stroke-width="1.2"/>
    <text x="22" y="34" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">3 FOCUSED TOOLS</text>
    <rect x="22" y="52" width="202" height="52" rx="10" fill="{p['card2']}" stroke="{p['border']}" stroke-width="1"/>
    <text x="36" y="74" fill="{p['cyan']}" font-family="{FONT_MONO}" font-size="14" font-weight="700">pack</text>
    <text x="36" y="93" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">Search + slice + .env shield</text>

    <rect x="22" y="114" width="202" height="52" rx="10" fill="{p['card2']}" stroke="{p['border']}" stroke-width="1"/>
    <text x="36" y="136" fill="{p['green']}" font-family="{FONT_MONO}" font-size="14" font-weight="700">ship</text>
    <text x="36" y="155" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">Edit + test + auto rollback</text>

    <rect x="22" y="176" width="202" height="52" rx="10" fill="{p['card2']}" stroke="{p['border']}" stroke-width="1"/>
    <text x="36" y="198" fill="{p['amber']}" font-family="{FONT_MONO}" font-size="14" font-weight="700">batch</text>
    <text x="36" y="217" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">Read-only JS repo filter</text>
  </g>
</svg>
"""
    (ASSETS_DIR / f"hero-{theme}.svg").write_text(svg, encoding="utf-8")


def write_how_it_works_svg(theme: str) -> None:
    p = PALETTES[theme]
    slow_steps = [
        ("Turn 1", "Search where calculateTax is defined", p["track"], p["body"]),
        ("Turn 2", "Pause... read tax.ts", p["track"], p["body"]),
        ("Turn 3", "Pause... read invoice.ts", p["track"], p["body"]),
        ("Turn 4", "Pause... read checkout.ts", p["track"], p["body"]),
        ("Turn 5", "Pause... read cart.test.ts", p["track"], p["body"]),
        ("Turn 6", "Edit tax.ts → save → edit invoice.ts", p["track"], p["body"]),
        ("Turn 7+", "Run tests → FAIL → messy half-edited files left behind", p["redBg"], p["redText"]),
    ]

    left_rows = []
    y = 122
    for tag, desc, bg_c, fg_c in slow_steps:
        stroke_c = p["red"] if bg_c == p["redBg"] else p["border"]
        left_rows.append(
            f'<rect x="64" y="{y}" width="492" height="44" rx="9" fill="{bg_c}" stroke="{stroke_c}" stroke-width="1"/>'
            f'<text x="82" y="{y + 27}" fill="{p["muted"] if bg_c != p["redBg"] else p["redText"]}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">{tag}</text>'
            f'<text x="150" y="{y + 27}" fill="{fg_c}" font-family="{FONT_SANS}" font-size="14" font-weight="600">{desc}</text>'
        )
        y += 53

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 525" width="1200" height="525" role="img" aria-label="Without Turnpack vs With Turnpack workflow comparison">
  <rect width="1200" height="525" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <!-- Left Card: Normal AI Loop -->
  <rect x="34" y="30" width="552" height="465" rx="16" fill="{p['card']}" stroke="{p['border']}" stroke-width="1.2"/>
  <rect x="64" y="54" width="142" height="26" rx="13" fill="{p['redBg']}" stroke="{p['red']}" stroke-width="1"/>
  <text x="135" y="72" text-anchor="middle" fill="{p['redText']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">NORMAL AI LOOP</text>
  <text x="64" y="106" fill="{p['title']}" font-family="{FONT_SANS}" font-size="21" font-weight="700">Repeated stop-and-go round trips</text>
  {"".join(left_rows)}

  <!-- Arrow Badge Center -->
  <circle cx="600" cy="262" r="24" fill="{p['green']}" stroke="{p['bg']}" stroke-width="4"/>
  <text x="600" y="269" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_SANS}" font-size="22" font-weight="800">→</text>

  <!-- Right Card: With Turnpack -->
  <rect x="614" y="30" width="552" height="465" rx="16" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.5"/>
  <rect x="644" y="54" width="166" height="26" rx="13" fill="{p['greenBg']}" stroke="{p['green']}" stroke-width="1"/>
  <text x="727" y="72" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">WITH TURNPACK</text>
  <text x="644" y="106" fill="{p['title']}" font-family="{FONT_SANS}" font-size="21" font-weight="700">Bundle reads, verify edits, or rewind clean</text>

  <!-- Step 1 -->
  <rect x="644" y="132" width="492" height="148" rx="14" fill="{p['card2']}" stroke="{p['cyan']}" stroke-width="1.2"/>
  <rect x="664" y="150" width="118" height="24" rx="6" fill="{p['cyanBg']}"/>
  <text x="723" y="166" text-anchor="middle" fill="{p['cyan']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">STEP 1 · pack</text>
  <text x="796" y="167" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">one call, runs locally in milliseconds</text>
  <text x="664" y="198" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Gather everything the AI needs in one trip</text>
  <text x="664" y="224" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Searches patterns + slices exact files &amp; functions together</text>
  <text x="664" y="246" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Automatically shields .env, .pem &amp; private keys by default</text>
  <text x="664" y="268" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Caps the reply size; overflow goes to files, not your context</text>

  <!-- Step 2 -->
  <rect x="644" y="302" width="492" height="168" rx="14" fill="{p['card2']}" stroke="{p['green']}" stroke-width="1.2"/>
  <rect x="664" y="320" width="118" height="24" rx="6" fill="{p['greenBg']}"/>
  <text x="723" y="336" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">STEP 2 · ship</text>
  <text x="796" y="337" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">all-or-nothing</text>
  <text x="664" y="368" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Apply multi-file edits + test in one boundary</text>
  <text x="664" y="394" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Validates every file before writing anything to disk</text>
  <text x="664" y="416" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Runs your test / typecheck command right after writing</text>
  <rect x="664" y="428" width="452" height="28" rx="7" fill="{p['greenBg']}"/>
  <text x="678" y="447" fill="{p['greenText']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">Tests pass → SHIPPED   |   Tests fail → byte-exact auto rollback</text>
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
  <text x="762" y="490" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">• Local GPU: ~1.1k-token tool schema, bounded replies</text>
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
        ("pack", p["cyan"], "Search + read many files", "in one call"),
        ("ship", p["green"], "Edit, test, and undo", "if the tests fail"),
        ("batch", p["amber"], "One read-only script", "instead of 40 reads"),
    ]
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

  <text x="80" y="218" fill="{p['title']}" font-family="{FONT_SANS}" font-size="58" font-weight="800" letter-spacing="-1.6">Stop watching your AI</text>
  <text x="80" y="286" fill="{p['title']}" font-family="{FONT_SANS}" font-size="58" font-weight="800" letter-spacing="-1.6">read one file at a time.</text>
  <text x="80" y="334" fill="{p['body']}" font-family="{FONT_SANS}" font-size="25">A local MCP server that folds an agent's round trips into single calls.</text>

  {"".join(cards)}

  <rect x="80" y="536" width="322" height="50" rx="12" fill="{p['greenBg']}" stroke="{p['green']}" stroke-width="1.2"/>
  <text x="104" y="569" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="22" font-weight="700">npx turnpack demo</text>
  <text x="1200" y="569" text-anchor="end" fill="{p['muted']}" font-family="{FONT_SANS}" font-size="20" font-weight="600">No API keys · zero dependencies · MIT</text>
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
    done = subprocess.run(["node", str(cli), *args], check=True, capture_output=True, text=True, env=env)
    return [line.rstrip() for line in done.stdout.strip("\n").split("\n")]


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
    width, height = 960, 600
    line_height = 27
    f_mono = load_font(16, mono=True)
    f_title = load_font(15, mono=False)

    demo_lines = capture_cli("demo")
    doctor_lines = capture_cli("doctor")

    # Reveal the demo two lines at a time (each tool prints a "did" line and a "->" result line).
    header = 2
    demo_reveals = [demo_lines[: header + 2 * n] for n in range(1, 6)] + [demo_lines]
    scenes = [{"cmd": "$ npx turnpack demo", "lines": [], "hold": 4, "type": True}]
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
        write_how_it_works_svg(th)
        write_ttft_tax_svg(th)
        write_time_saved_svg(th)
    write_social_preview_svg()
    render_demo_gif()
