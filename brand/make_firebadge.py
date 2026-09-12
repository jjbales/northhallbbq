"""North Hall BBQ — fire-and-logs badge, rebuilt as clean vector.

Same idea as the reference: crossed logs under a flame, arched name on a band,
big BBQ underneath. Drawn from scratch in paths so it scales and prints.
"""
import math, pathlib
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

SLAB = "/usr/share/texmf/fonts/opentype/public/tex-gyre/texgyrebonum-bold.otf"
_cache = {}

def _font(path):
    if path not in _cache:
        f = TTFont(path)
        _cache[path] = (f, f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm, f["hmtx"])
    return _cache[path]

def _glyph(ch, path):
    f, gs, cmap, upm, hmtx = _font(path)
    name = cmap.get(ord(ch))
    if name is None:
        return None, upm // 3, upm
    pen = SVGPathPen(gs)
    gs[name].draw(pen)
    return pen.getCommands(), hmtx[name][0], upm

def measure(text, size, tracking=0.0, path=SLAB):
    _, _, _, upm, _ = _font(path)
    s = size / upm
    w = sum(_glyph(c, path)[1] * s for c in text)
    return w + tracking * size * (len(text) - 1)

def text_path(text, size, x=0, y=0, tracking=0.0, anchor="start", fill="#000", path=SLAB):
    _, _, _, upm, _ = _font(path)
    s = size / upm
    total = measure(text, size, tracking, path)
    if anchor == "middle": x -= total / 2
    elif anchor == "end":  x -= total
    out, cx = [], x
    for i, ch in enumerate(text):
        d, adv, _ = _glyph(ch, path)
        if d and ch != " ":
            out.append(f'<path d="{d}" transform="translate({cx:.2f},{y:.2f}) scale({s:.5f},{-s:.5f})" fill="{fill}"/>')
        cx += adv * s + (tracking * size if i < len(text) - 1 else 0)
    return "\n".join(out)

def arc_text(text, size, cx, cy, r, tracking=0.0, fill="#000", path=SLAB):
    """Gentle upward arch: circle centre sits below, text rides the top."""
    _, _, _, upm, _ = _font(path)
    s = size / upm
    widths = [_glyph(c, path)[1] * s for c in text]
    total = sum(widths) + tracking * size * (len(text) - 1)
    span = math.degrees(total / r)
    start = -span / 2
    out, walked = [], 0.0
    for i, ch in enumerate(text):
        ang = start + math.degrees((walked + widths[i] / 2) / r)
        a = math.radians(ang)
        px, py = cx + r * math.sin(a), cy - r * math.cos(a)
        if ch != " ":
            d, _, _ = _glyph(ch, path)
            if d:
                out.append(f'<g transform="translate({px:.2f},{py:.2f}) rotate({ang:.2f}) '
                           f'translate({-widths[i]/2:.2f},0) scale({s:.5f},{-s:.5f})">'
                           f'<path d="{d}" fill="{fill}"/></g>')
        walked += widths[i] + tracking * size
    return "\n".join(out)

# ------------------------------------------------------------------ artwork --
def flame(p):
    """Three nested flame shapes, hottest in the middle."""
    return f'''
  <path d="M 300 44 C 268 96 250 128 250 152 C 250 168 256 180 266 188
           C 252 176 246 160 248 142 C 226 168 216 192 218 214
           C 220 244 246 264 278 268 L 322 268 C 356 264 382 242 384 212
           C 386 188 374 164 352 142 C 356 162 350 178 336 190
           C 346 178 350 162 346 144 C 340 112 322 78 300 44 Z" fill="{p['flame_dark']}"/>
  <path d="M 300 108 C 282 142 272 164 272 182 C 272 206 284 222 300 230
           C 318 222 330 206 330 182 C 330 162 318 140 300 108 Z" fill="{p['flame_mid']}"/>
  <path d="M 300 152 C 292 172 288 186 288 196 C 288 212 294 222 301 226
           C 310 221 315 211 315 197 C 315 185 309 170 300 152 Z" fill="{p['flame_hot']}"/>'''

def log(x, y, rot, p, length=118, rad=25):
    """One split log: body, end grain, and a couple of grain lines."""
    return f'''
  <g transform="translate({x},{y}) rotate({rot})">
    <rect x="{-length}" y="{-rad}" width="{2*length}" height="{2*rad}" rx="{rad}"
          fill="{p['log']}" stroke="{p['ink']}" stroke-width="9"/>
    <ellipse cx="{-length+6}" cy="0" rx="13" ry="{rad-7}" fill="{p['log_end']}"
             stroke="{p['ink']}" stroke-width="8"/>
    <ellipse cx="{length-6}" cy="0" rx="13" ry="{rad-7}" fill="{p['log_end']}"
             stroke="{p['ink']}" stroke-width="8"/>
    <path d="M {-length+34} -9 H {length-34} M {-length+46} 9 H {length-46}"
          stroke="{p['ink']}" stroke-width="6" stroke-linecap="round" opacity="0.55"/>
  </g>'''

def fit_size(text, target_w, tracking=0.0, path=SLAB, start=200):
    """Pick the type size that makes `text` exactly target_w wide."""
    w1 = measure(text, start, tracking, path)
    return start * target_w / w1

def badge(p, size=620):
    S, c = size, size / 2
    ink, cream = p['ink'], p['cream']
    R_OUT, R_IN = 286, 262
    BAND_T, BAND_B = 330, 430          # dark name band
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" width="{S}" height="{S}">']

    # silhouette: circle plus the band poking out either side
    out.append(f'<g fill="{ink}">'
               f'<circle cx="{c}" cy="{c}" r="{R_OUT}"/>'
               f'<rect x="12" y="{BAND_T - 14}" width="{S-24}" height="{BAND_B - BAND_T + 28}" rx="28"/>'
               f'</g>')
    out.append(f'<circle cx="{c}" cy="{c}" r="{R_IN}" fill="{cream}"/>')
    out.append(f'<rect x="34" y="{BAND_T}" width="{S-68}" height="{BAND_B - BAND_T}" rx="18" fill="{ink}"/>')

    # fire over crossed logs, scaled to sit in the upper field
    art = flame(p) + log(300, 268, -17, p) + log(300, 282, 15, p)
    out.append(f'<g transform="translate(300,190) scale(0.88) translate(-300,-177)">{art}</g>')

    # arc ticks either side
    out.append(f'<path d="M 84 296 A 224 224 0 0 1 138 168" fill="none" stroke="{ink}" '
               f'stroke-width="13" stroke-linecap="round"/>')
    out.append(f'<path d="M 536 296 A 224 224 0 0 0 482 168" fill="none" stroke="{ink}" '
               f'stroke-width="13" stroke-linecap="round"/>')

    # name: gentle arch, baseline sitting inside the band
    name_size = fit_size("NORTH HALL", 470, 0.035)
    out.append(arc_text("NORTH HALL", name_size, c, 402 + 1500, 1500, tracking=0.035, fill=cream))

    # BBQ under the band, sized to the space it has
    BBQ_W = 286
    bbq_size = fit_size("BBQ", BBQ_W, 0.02)
    out.append(text_path("BBQ", bbq_size, c, 524, tracking=0.02, anchor="middle", fill=p['accent']))
    dash_y = 524 - bbq_size * 0.33
    for sx in (c - BBQ_W / 2 - 44, c + BBQ_W / 2 + 44):
        out.append(f'<path d="M {sx-28} {dash_y:.0f} H {sx+28}" stroke="{p["accent"]}" '
                   f'stroke-width="14" stroke-linecap="round"/>')
    out.append('</svg>')
    return "\n".join(out)

def firemark(p, size=256, ring=False):
    """Fire and logs only — favicon, profile picture, header mark."""
    S, c = size, size / 2
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 620" width="{S}" height="{S}">']
    if ring:
        out.append(f'<circle cx="310" cy="310" r="300" fill="{p["cream"]}" stroke="{p["ink"]}" stroke-width="20"/>')
    art = flame(p) + log(300, 268, -17, p) + log(300, 282, 15, p)
    out.append(f'<g transform="translate(310,318) scale(1.28) translate(-300,-177)">{art}</g>')
    out.append('</svg>')
    return "\n".join(out)

WARM = dict(ink="#3b2a21", cream="#f6efe1", accent="#a63a28",
            flame_dark="#a33422", flame_mid="#e0702a", flame_hot="#f4b13c",
            log="#8a5a34", log_end="#c39a6b")

# Green-dominant, fire kept warm but pulled toward ember/amber so it sits with
# forest green instead of fighting it. Logs desaturated so the fire is the only
# thing shouting.
GREEN = dict(ink="#22351f", cream="#f4f1e6", accent="#2d5035",
             flame_dark="#c2481f", flame_mid="#e8822a", flame_hot="#f7c14a",
             log="#7d6647", log_end="#b9a481")

# Same, but BBQ set in ember so the warm side carries through the whole mark.
GREEN_EMBER = dict(GREEN, accent="#c2481f")

OUT = pathlib.Path(__file__).parent
BUILDS = {
    "firebadge-warm": badge(WARM),
    "firebadge-green": badge(GREEN),
    "firebadge-green-ember": badge(GREEN_EMBER),
    "firemark-green": firemark(GREEN),
    "firemark-green-ring": firemark(GREEN, ring=True),
    # For sitting directly on the green header: cream shapes, green separations.
    "firemark-knockout": firemark(dict(GREEN, ink="#2d5035", log="#f4f1e6", log_end="#cfc8b2",
                                       flame_dark="#f4f1e6", flame_mid="#2d5035", flame_hot="#f4f1e6")),
}
for name, svg in BUILDS.items():
    (OUT / f"{name}.svg").write_text(svg)
    print("wrote", name + ".svg")
