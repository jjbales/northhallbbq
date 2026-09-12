"""North Hall BBQ mark generator -> self-contained SVG (text converted to outlines)."""
import math, pathlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

FONT = "/usr/share/texmf/fonts/opentype/public/tex-gyre/texgyreheroscn-bold.otf"
_f = TTFont(FONT)
_gs = _f.getGlyphSet()
_cmap = _f.getBestCmap()
_upm = _f["head"].unitsPerEm
_hmtx = _f["hmtx"]

def _glyph(ch):
    name = _cmap.get(ord(ch))
    if name is None:
        return None, _upm // 3
    pen = SVGPathPen(_gs)
    _gs[name].draw(pen)
    return pen.getCommands(), _hmtx[name][0]

def measure(text, size, tracking=0.0):
    """Width in user units. tracking is a fraction of size added between glyphs."""
    s = size / _upm
    w = 0.0
    for i, ch in enumerate(text):
        _, adv = _glyph(ch)
        w += adv * s
        if i < len(text) - 1:
            w += tracking * size
    return w

def text_path(text, size, x=0, y=0, tracking=0.0, anchor="start", fill="#000"):
    """Straight run of text as outlined paths."""
    s = size / _upm
    total = measure(text, size, tracking)
    if anchor == "middle":
        x -= total / 2
    elif anchor == "end":
        x -= total
    out = []
    cx = x
    for i, ch in enumerate(text):
        d, adv = _glyph(ch)
        if d and ch != " ":
            out.append(f'<path d="{d}" transform="translate({cx:.2f},{y:.2f}) scale({s:.5f},{-s:.5f})" fill="{fill}"/>')
        cx += adv * s
        if i < len(text) - 1:
            cx += tracking * size
    return "\n".join(out)

def arc_text(text, size, cx, cy, r, center_deg=0, tracking=0.0, fill="#000", flip=False):
    """Text on a circle, centred on center_deg (0 = 12 o'clock, clockwise positive).

    Glyphs sit on a baseline at radius r and grow OUTWARD, except when flip=True
    (bottom-of-badge text), where they read right-way-up and grow INWARD.
    """
    s = size / _upm
    widths = [_glyph(ch)[1] * s for ch in text]
    total = sum(widths) + tracking * size * (len(text) - 1)
    span = math.degrees(total / r)          # natural angular width, no stretching
    direction = -1 if flip else 1
    start = center_deg - direction * span / 2
    out = []
    walked = 0.0
    for i, ch in enumerate(text):
        mid = walked + widths[i] / 2
        ang = start + direction * math.degrees(mid / r)
        a = math.radians(ang)
        px = cx + r * math.sin(a)
        py = cy - r * math.cos(a)
        rot = ang + (180 if flip else 0)
        if ch != " ":
            d, _ = _glyph(ch)
            if d:
                out.append(
                    f'<g transform="translate({px:.2f},{py:.2f}) rotate({rot:.2f}) '
                    f'translate({-widths[i]/2:.2f},0) scale({s:.5f},{-s:.5f})">'
                    f'<path d="{d}" fill="{fill}"/></g>')
        walked += widths[i] + tracking * size
    return "\n".join(out)

def on_circle(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.sin(a), cy - r * math.cos(a)

# ---------------------------------------------------------------- the mark ---
GREEN = "#2d5035"

def smoker(fill, x=0, y=0, scale=1.0):
    """Original offset-firebox smoker silhouette with three smoke curls."""
    g = []
    # smoke curls
    for i, (sx, h, w) in enumerate(((-52, 62, 20), (-16, 78, 24), (22, 58, 18))):
        g.append(
            f'<path d="M {sx} {-104 + 0} c {-w} {-h*0.28} {w} {-h*0.5} {-w*0.25} {-h*0.8}" '
            f'fill="none" stroke="{fill}" stroke-width="9" stroke-linecap="round"/>')
    # chimney
    g.append(f'<rect x="34" y="-112" width="22" height="46" rx="4" fill="{fill}"/>')
    # barrel
    g.append(f'<rect x="-62" y="-68" width="124" height="62" rx="28" fill="{fill}"/>')
    # firebox
    g.append(f'<rect x="-98" y="-52" width="42" height="46" rx="8" fill="{fill}"/>')
    # legs
    g.append(f'<path d="M -40 -6 l -10 34 M 40 -6 l 10 34" stroke="{fill}" stroke-width="11" stroke-linecap="round"/>')
    # ground line
    g.append(f'<path d="M -74 30 H 74" stroke="{fill}" stroke-width="11" stroke-linecap="round"/>')
    return (f'<g transform="translate({x},{y}) scale({scale})">' + "\n".join(g) + "</g>")

def diamond(x, y, s, fill):
    return f'<path d="M {x} {y-s} L {x+s} {y} L {x} {y+s} L {x-s} {y} Z" fill="{fill}"/>'

def badge(ink, ring_text_ink=None, bg=None, seam="#ffffff"):
    """The primary circular mark. Everything drawn in one colour so it survives
    one-colour printing, embroidery and a vinyl cutter."""
    rt = ring_text_ink or ink
    S = 600
    c = S / 2
    R_OUT, R_IN = 284, 226          # the type band lives between these
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">']
    if bg:
        out.append(f'<rect width="{S}" height="{S}" fill="{bg}"/>')
    out.append(f'<circle cx="{c}" cy="{c}" r="{R_OUT}" fill="none" stroke="{ink}" stroke-width="13"/>')
    out.append(f'<circle cx="{c}" cy="{c}" r="{R_IN}" fill="none" stroke="{ink}" stroke-width="5"/>')

    # top arc grows outward from its baseline; bottom arc grows inward
    out.append(arc_text("NORTH HALL BBQ", 52, c, c, R_IN + 8, center_deg=0, tracking=0.03, fill=rt))
    out.append(arc_text("GAINESVILLE, GEORGIA", 38, c, c, R_OUT - 20, center_deg=180,
                        tracking=0.06, fill=rt, flip=True))

    # separators at 9 and 3 o'clock, centred in the band
    for deg in (-90, 90):
        dx, dy = on_circle(c, c, (R_OUT + R_IN) / 2, deg)
        out.append(diamond(dx, dy, 10, rt))

    out.append(smoker(ink, c, c - 16, 1.02))
    out.append(text_path("EST. 2014", 34, c, c + 132, tracking=0.16, anchor="middle", fill=rt))
    out.append("</svg>")
    return "\n".join(out)

def horizontal(ink, sub_ink=None, bg=None):
    """Lockup for the website header and anywhere wide and short."""
    si = sub_ink or ink
    W, H = 1100, 300
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">']
    if bg:
        out.append(f'<rect width="{W}" height="{H}" fill="{bg}"/>')
    out.append(smoker(ink, 165, 178, 0.82))
    out.append(f'<path d="M 300 62 V 238" stroke="{ink}" stroke-width="5" opacity="0.35"/>')
    out.append(text_path("NORTH HALL", 96, 340, 140, tracking=0.03, fill=ink))
    out.append(text_path("BBQ", 96, 340 + measure("NORTH HALL", 96, 0.03) + 26, 140, tracking=0.03, fill=si))
    out.append(f'<path d="M 340 168 H {340 + measure("NORTH HALL BBQ ", 96, 0.03):.0f}" stroke="{ink}" stroke-width="5" opacity="0.35"/>')
    out.append(text_path("SINCE 2014  ·  GAINESVILLE, GEORGIA", 34, 340, 212, tracking=0.12, fill=si))
    out.append("</svg>")
    return "\n".join(out)

def icon(ink, bg=None):
    """Small-size mark: the smoker alone in a circle. Favicon, app tile, sticker."""
    S = 256
    c = S / 2
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">']
    out.append(f'<circle cx="{c}" cy="{c}" r="{c}" fill="{bg or "none"}"/>')
    out.append(smoker(ink, c, c + 52, 0.78))
    out.append("</svg>")
    return "\n".join(out)

OUT = pathlib.Path(__file__).parent
files = {
    "north-hall-bbq-badge-green.svg":  badge(GREEN),
    "north-hall-bbq-badge-black.svg":  badge("#000000"),
    "north-hall-bbq-badge-white.svg":  badge("#ffffff", bg=GREEN),
    "north-hall-bbq-horizontal-green.svg": horizontal(GREEN),
    "north-hall-bbq-horizontal-white.svg": horizontal("#ffffff", bg=GREEN),
    "north-hall-bbq-icon-green.svg":   icon(GREEN),
    "north-hall-bbq-icon-white.svg":   icon("#ffffff", bg=GREEN),
    "north-hall-bbq-mark-knockout.svg": icon("#ffffff"),
}
for name, svg in files.items():
    (OUT / name).write_text(svg)
    print("wrote", name)
