"""Validate the Cradle icon SVG: structure, coordinate sanity, and renderability."""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "plugin" / "icon.svg"
svg = PATH.read_text(encoding="utf-8")

failures = []

# Size limit enforced by the plugin loader.
size = len(svg.encode("utf-8"))
print(f"size: {size} bytes (limit 262144)")
if size > 262144:
    failures.append("icon exceeds 256 KiB")

# Required SVG shape.
if "<svg" not in svg or "</svg>" not in svg:
    failures.append("missing svg root")
if 'xmlns="http://www.w3.org/2000/svg"' not in svg:
    failures.append("missing SVG namespace")
if 'viewBox="0 0 24 24"' not in svg:
    failures.append("unexpected viewBox")

paths = re.findall(r'<path\s+d="([^"]+)"', svg)
circles = re.findall(r"<circle[^>]*>", svg)
print(f"paths: {len(paths)}  circles: {len(circles)}")
if len(paths) + len(circles) == 0:
    failures.append("icon has no drawable shapes")

# Every path must contain at least one coordinate pair.
for i, d in enumerate(paths):
    nums = [float(n) for n in re.findall(r"-?\d+\.?\d*", d)]
    print(f"  path {i}: {len(nums)} coords, starts '{d[:32]}'")
    if len(nums) < 2:
        failures.append(f"path {i} has fewer than two coordinates")

# Only ABSOLUTE coordinates constrain the canvas: an `M x y` pen move and the
# circle centre/radius. Curve data after `c`/`l`/`h`/`v` is relative to the
# current point, so its signed deltas may legitimately be negative.
abs_coords = []
for d in paths:
    for m in re.finditer(r"M\s*(-?\d+\.?\d*)[ ,]+(-?\d+\.?\d*)", d):
        abs_coords += [float(m.group(1)), float(m.group(2))]
for c in circles:
    abs_coords += [float(n) for n in re.findall(r"(?:cx|cy|r)=\"(-?\d+\.?\d*)\"", c)]

if abs_coords:
    lo, hi = min(abs_coords), max(abs_coords)
    print(f"absolute coordinate range: {lo} .. {hi}")
    if lo < 0 or hi > 24:
        failures.append(f"absolute coordinates outside the 24x24 canvas: {lo}..{hi}")

# currentColor keeps the icon themeable like the host's own icons.
if "currentColor" in svg:
    print("uses currentColor: yes (inherits host theme)")
else:
    failures.append("icon does not use currentColor; it will not follow the theme")

# Try a real rasterization when a renderer is available.
try:
    import cairosvg  # type: ignore

    png = cairosvg.svg2png(svg.encode("utf-8"), output_width=48, output_height=48)
    (ROOT / "test" / "icon-preview.png").write_bytes(png)
    print(f"rasterized: {len(png)} bytes PNG")
except ImportError:
    print("rasterizer unavailable (cairosvg not installed) — structure validated only")

if failures:
    print("\nFAIL: " + "; ".join(failures))
    sys.exit(1)
print("\nPASS: icon is valid, themeable, and within limits")
