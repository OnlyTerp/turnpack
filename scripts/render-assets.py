#!/usr/bin/env python3
"""Generate adaptive light/dark SVG diagrams and a crisp terminal demo GIF for Turnpack."""
import os
import shutil
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"
FRAMES_DIR = Path(os.environ.get("TURNPACK_STAGE_DIR", str(REPO_ROOT.parent / "scratch-frames"))) / "gif-frames"

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
  <rect x="664" y="150" width="84" height="24" rx="6" fill="{p['cyanBg']}"/>
  <text x="706" y="166" text-anchor="middle" fill="{p['cyan']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">STEP 1 · pack</text>
  <text x="760" y="167" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">1 local call (~19ms engine)</text>
  <text x="664" y="198" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Gather everything the AI needs in one trip</text>
  <text x="664" y="224" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Searches patterns + slices exact files &amp; functions together</text>
  <text x="664" y="246" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Automatically shields .env, .pem &amp; private keys by default</text>
  <text x="664" y="268" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14">• Splits giant outputs cleanly so your chat never overflows</text>

  <!-- Step 2 -->
  <rect x="644" y="302" width="492" height="168" rx="14" fill="{p['card2']}" stroke="{p['green']}" stroke-width="1.2"/>
  <rect x="664" y="320" width="84" height="24" rx="6" fill="{p['greenBg']}"/>
  <text x="706" y="336" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">STEP 2 · ship</text>
  <text x="760" y="337" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">All-or-nothing safety net</text>
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

  <text x="58" y="48" fill="{p['title']}" font-family="{FONT_SANS}" font-size="23.5" font-weight="800">Why AI Tool Loops Feel So Slow: You Pay TTFT + Slow Tokens on Every Step</text>
  <text x="58" y="74" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14.5">Even when reading a file takes 0.02s locally, every separate tool call forces a brand-new provider round-trip:</text>

  <!-- Section A: Anatomy of ONE Tool Call -->
  <rect x="44" y="94" width="1112" height="148" rx="14" fill="{p['card']}" stroke="{p['border']}" stroke-width="1.2"/>
  <text x="64" y="120" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">ANATOMY OF ONE INTERMEDIATE AI TOOL CALL</text>

  <rect x="64" y="132" width="446" height="42" rx="8" fill="{p['red']}" opacity="0.85"/>
  <text x="287" y="158" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">1. Time to First Token (TTFT): 5s–25s+ dead freeze</text>

  <rect x="514" y="132" width="538" height="42" rx="8" fill="{p['amber']}" opacity="0.86"/>
  <text x="783" y="158" text-anchor="middle" fill="#0B0F17" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">2. Thinking &amp; Slow Token Stream (15–40 tok/s): 5s–25s+</text>

  <rect x="1056" y="132" width="80" height="42" rx="8" fill="{p['green']}"/>
  <text x="1096" y="158" text-anchor="middle" fill="#FFFFFF" font-family="{FONT_MONO}" font-size="12" font-weight="700">0.02s tool</text>

  <circle cx="72" cy="196" r="5" fill="{p['red']}"/>
  <text x="84" y="201" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13">TTFT (Startup Freeze): Queueing + re-reading growing chat history before a single word appears.</text>
  <circle cx="72" cy="218" r="5" fill="{p['amber']}"/>
  <text x="84" y="223" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13">Token Wait: Thinking &amp; tool JSON streamed token-by-token.   Local execution (~20ms) is practically instant.</text>

  <!-- Section B: 16 Calls vs 4 Calls -->
  <text x="58" y="284" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">Normal Chatty Loop — 16 separate tool calls</text>
  <text x="1142" y="284" text-anchor="end" fill="{p['red']}" font-family="{FONT_MONO}" font-size="13" font-weight="700">16 × (TTFT + token wait) = 5 to 13+ minutes waiting</text>
  <rect x="52" y="308" width="1096" height="52" rx="10" fill="{p['card']}" stroke="{p['border']}" stroke-width="1"/>
  {"".join(loop16_svg)}
  <text x="1030" y="339" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12" font-weight="700">16× PAID</text>

  <text x="58" y="378" fill="{p['title']}" font-family="{FONT_SANS}" font-size="17" font-weight="700">With Turnpack — 4 bundled calls (pack + ship)</text>
  <rect x="52" y="390" width="1096" height="44" rx="10" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.3"/>
  {"".join(loop4_svg)}
  <rect x="308" y="396" width="832" height="32" rx="6" fill="{p['greenBg']}"/>
  <text x="724" y="417" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">12 repeated TTFT freezes + 12 intermediate token streams eliminated (~75% less dead waiting)</text>

  <text x="58" y="466" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">Red = TTFT dead wait per call   ·   Amber = Slow token stream per call   ·   Green = Time your AI skips completely with Turnpack</text>
</svg>
"""
    (ASSETS_DIR / f"ttft-tax-{theme}.svg").write_text(svg, encoding="utf-8")


def write_time_saved_svg(theme: str) -> None:
    p = PALETTES[theme]
    rows = [
        ("Fast / Warm-Cache API", "2s TTFT + 5s stream = 7s/turn", 112, 28, "1m 52s", "28s", "Save ~1m 24s / task"),
        ("Frontier Reasoning", "6s TTFT + 12s stream = 18s/turn", 288, 72, "4m 48s", "1m 12s", "Save ~3m 36s / task"),
        ("High-TTFT / Busy API", "15s TTFT + 20s stream = 35s/turn", 560, 140, "9m 20s", "2m 20s", "Save ~7m 00s / task"),
        ("Slow-Prefill / Local GPU", "25s TTFT + 25s @ 18 tok/s = 50s/turn", 800, 200, "13m 20s", "3m 20s", "Save ~10m 00s / task"),
    ]

    bars_svg = []
    y = 114
    max_bar = 370
    max_sec = 800
    for title, sub, base_sec, tp_sec, base_lbl, tp_lbl, save_lbl in rows:
        base_w = max(24, int((base_sec / max_sec) * max_bar))
        tp_w = max(14, int((tp_sec / max_sec) * max_bar))
        bars_svg.append(
            f'<text x="58" y="{y}" fill="{p["title"]}" font-family="{FONT_SANS}" font-size="15" font-weight="700">{title} '
            f'<tspan fill="{p["muted"]}" font-family="{FONT_MONO}" font-size="11.5" font-weight="500">({sub})</tspan></text>'
            f'<text x="708" y="{y}" text-anchor="end" fill="{p["green"]}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700">{save_lbl}</text>'
            f'<rect x="58" y="{y + 10}" width="{max_bar}" height="20" rx="5" fill="{p["track"]}"/>'
            f'<rect x="58" y="{y + 10}" width="{base_w}" height="20" rx="5" fill="{p["red"]}" opacity="0.76"/>'
            f'<text x="{58 + max_bar + 14}" y="{y + 25}" fill="{p["body"]}" font-family="{FONT_MONO}" font-size="12">Normal 16t: ~{base_lbl}</text>'
            f'<rect x="58" y="{y + 35}" width="{max_bar}" height="20" rx="5" fill="{p["track"]}"/>'
            f'<rect x="58" y="{y + 35}" width="{tp_w}" height="20" rx="5" fill="{p["green"]}"/>'
            f'<text x="{58 + max_bar + 14}" y="{y + 50}" fill="{p["greenText"]}" font-family="{FONT_MONO}" font-size="12" font-weight="700">Turnpack 4t: ~{tp_lbl}</text>'
        )
        y += 100

    weekly_rows = [
        ("Fast Warm API (7s/turn)", "~2.3 hrs / wk", p["body"]),
        ("Frontier Reasoning (18s/turn)", "~6.0 hrs / wk", p["title"]),
        ("High-TTFT / Busy (35s/turn)", "~11.7 hrs / wk", p["greenText"]),
        ("Local / Slow GPU (50s/turn)", "~16.7 hrs / wk", p["green"]),
    ]
    wk_svg = []
    wy = 196
    for lbl, hrs, clr in weekly_rows:
        wk_svg.append(
            f'<rect x="762" y="{wy}" width="366" height="44" rx="9" fill="{p["card2"]}" stroke="{p["border"]}" stroke-width="1"/>'
            f'<text x="778" y="{wy + 27}" fill="{p["body"]}" font-family="{FONT_SANS}" font-size="13.5" font-weight="600">{lbl}</text>'
            f'<text x="1112" y="{wy + 27}" text-anchor="end" fill="{clr}" font-family="{FONT_MONO}" font-size="14" font-weight="700">{hrs}</text>'
        )
        wy += 54

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 555" width="1200" height="555" role="img" aria-label="Time saved by provider TTFT and token speed">
  <rect width="1200" height="555" rx="20" fill="{p['bg']}" stroke="{p['border']}" stroke-width="1.5"/>

  <text x="58" y="48" fill="{p['title']}" font-family="{FONT_SANS}" font-size="24" font-weight="800">Real-World Waiting Time Saved by Provider Speed (16-Turn Task → 4 Turns)</text>
  <text x="58" y="74" fill="{p['body']}" font-family="{FONT_SANS}" font-size="14.5">The slower your model's Time-to-First-Token (TTFT) or token speed (tok/s), the bigger difference fewer turns makes:</text>

  {"".join(bars_svg)}

  <!-- Weekly Impact Highlight Box -->
  <rect x="738" y="104" width="414" height="390" rx="16" fill="{p['card']}" stroke="{p['green']}" stroke-width="1.4"/>
  <rect x="762" y="126" width="366" height="28" rx="14" fill="{p['greenBg']}"/>
  <text x="945" y="145" text-anchor="middle" fill="{p['greenText']}" font-family="{FONT_MONO}" font-size="11.5" font-weight="700">WEEKLY HOURS RECLAIMED (20 tasks/day · 5d/wk)</text>
  <text x="762" y="178" fill="{p['body']}" font-family="{FONT_SANS}" font-size="13.5">12 eliminated round-trips × 100 tasks/week:</text>

  {"".join(wk_svg)}

  <text x="762" y="434" fill="{p['title']}" font-family="{FONT_SANS}" font-size="13.5" font-weight="700">+ Context grows slower too:</text>
  <text x="762" y="456" fill="{p['body']}" font-family="{FONT_SANS}" font-size="12.5">Avoids 100k+ token TTFT spikes &amp; broken half-edits.</text>

  <text x="58" y="530" fill="{p['muted']}" font-family="{FONT_MONO}" font-size="12">Transparent math: turns_saved × (TTFT + tokens_per_turn ÷ tok/s). Plug in your own provider with npx turnpack estimate.</text>
</svg>
"""
    (ASSETS_DIR / f"time-saved-{theme}.svg").write_text(svg, encoding="utf-8")


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


def render_demo_gif() -> None:
    width, height = 960, 540
    f_mono = load_font(17, mono=True)
    f_title = load_font(15, mono=False)

    full_demo_lines = [
        ("#94A3B8", "turnpack live sandbox demo (isolated temp folder, 0 repo changes)"),
        ("#475569", "─────────────────────────────────────────────────────────────────"),
        ("#6EE7B7", "  [PASS] pack + secret shield        18ms  Bundled 2 files + .env shielded"),
        ("#FDE68A", "  [PASS] ship rollback on test fail  62ms  Restored exact pre-edit SHA-256"),
        ("#38BDF8", "  [PASS] ship verified 2-file edit   52ms  Applied 2 edits + tests passed"),
        ("#6EE7B7", "  [PASS] batch read-only analysis     9ms  Outlined files; exec disabled"),
        ("#475569", "─────────────────────────────────────────────────────────────────"),
        ("#10B981", "  ALL CHECKS PASSED in 148ms. Next: npx turnpack init"),
    ]
    doctor_lines = [
        ("#94A3B8", "turnpack doctor"),
        ("#475569", "────────────────────────────────────────────────────────────"),
        ("#6EE7B7", "  [OK  ] Node.js >= 22                      v24.16.0"),
        ("#6EE7B7", "  [OK  ] ripgrep fast search                 ripgrep 15.1.0"),
        ("#38BDF8", "  [OK  ] MCP stdio handshake + tools         pack, ship, batch (54ms)"),
        ("#6EE7B7", "  [OK  ] Compact schema budget (< 1,500 tok) 3289 bytes (~823 tokens)"),
        ("#6EE7B7", "  [OK  ] Default .env secret shield          active (blocked .env read)"),
        ("#475569", "────────────────────────────────────────────────────────────"),
        ("#F8FAFC", "  Ready for Claude Code, Codex CLI, OMP & Cursor."),
    ]

    scenes = [
        {"cmd": "$ npx turnpack demo", "lines": full_demo_lines, "hold": 16, "animate": False},
        {"cmd": "$ npx turnpack doctor", "lines": doctor_lines, "hold": 26, "animate": True},
        {"cmd": "$ npx turnpack demo", "lines": full_demo_lines[:2], "hold": 8, "animate": True},
        {"cmd": "$ npx turnpack demo", "lines": full_demo_lines[:3], "hold": 10, "animate": False},
        {"cmd": "$ npx turnpack demo", "lines": full_demo_lines[:4], "hold": 10, "animate": False},
        {"cmd": "$ npx turnpack demo", "lines": full_demo_lines, "hold": 18, "animate": False},
    ]

    frame_idx = 0
    for scene in scenes:
        cmd_text = scene["cmd"]
        step_lengths = [6, 13, len(cmd_text)] if scene["animate"] else [len(cmd_text)]
        for cut in step_lengths:
            img = Image.new("RGB", (width, height), "#090D16")
            draw = ImageDraw.Draw(img)
            # Outer card + terminal chrome
            draw.rounded_rectangle([24, 20, width - 24, height - 20], radius=16, fill="#0F172A", outline="#1E293B", width=2)
            draw.rounded_rectangle([24, 20, width - 24, 62], radius=16, fill="#162033")
            draw.rectangle([24, 48, width - 24, 62], fill="#162033")
            draw.ellipse([44, 34, 56, 46], fill="#EF4444")
            draw.ellipse([64, 34, 76, 46], fill="#F59E0B")
            draw.ellipse([84, 34, 96, 46], fill="#10B981")
            draw.text((120, 32), "turnpack — local zero-key MCP workflow", fill="#94A3B8", font=f_title)

            draw.text((48, 86), cmd_text[:cut] + (" _" if cut < len(cmd_text) else ""), fill="#F8FAFC", font=f_mono)

            if cut == len(cmd_text):
                ly = 128
                for color, line in scene["lines"]:
                    draw.text((48, ly), line, fill=color, font=f_mono)
                    ly += 34
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
    render_demo_gif()
