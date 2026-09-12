# North Hall BBQ — logo files

Everything here is original artwork, drawn as vector. No school marks, no
stock clip art, nothing adapted from another pit's logo.

## The mark

Crossed logs under an open flame, ringed in Forest Green, name on a band,
BBQ in ember below. The badge is green so it sits with the school colours and
the website; the fire stays warm because a green fire isn't a fire. The logs
are deliberately muted — the flame is the only thing in the mark allowed to
shout, which keeps green-and-red from turning into Christmas.

## Which file to hand someone

| Use | File |
|---|---|
| Shirt, sign, trailer, anything printed | `firebadge-green-ember.svg` |
| Printer who says "one colour only" | `firebadge-onecolor.svg` |
| On a green or dark background | `firebadge-reversed.svg` |
| Facebook / Instagram profile picture | `firemark-green-ring-512.png` |
| Website header, favicon, small sticker | `firemark-green.svg` |
| All-green version (no ember in the type) | `firebadge-green.svg` |
| Original brown/red colourway | `firebadge-warm.svg` |

The earlier smoker-badge files (`north-hall-bbq-*`) are still here if you ever
want them, but the fire badge is the mark now.

### Generating them

`make_firebadge.py` draws the fire badge; `make_logo.py` draws the older
smoker one. Both convert text to outlines, so nothing depends on fonts being
installed. Change a colour or a word and re-run.

Give a print shop the **.svg**. It's vector — infinitely scalable, no fuzzy
edges at any size. The PNGs are for the web and for anything that refuses SVG.

## Rules of thumb

- **Under about one inch, drop the badge and use the icon.** The ring text
  turns to mush below roughly 64px / 1in. That's what the icon is for.
- Keep clear space around the badge equal to the height of the "EST. 2014"
  line. Don't crowd it.
- Don't stretch it. Scale both directions together.
- Don't recolour it outside Forest Green `#2d5035`, black, or white.

## Colors

| | Hex | Notes |
|---|---|---|
| Forest Green | `#2d5035` | Primary. Matches North Hall High School's published color. |
| White | `#ffffff` | Reversed applications |
| Rich Black | `#000000` | One-colour printing |
| Athletic Gray | `#a9a8a9` | Secondary / rules only |

Colors are shared with the school on purpose — local pride — but this is an
independent business and the mark carries no school branding or endorsement.

## Regenerating

`make_logo.py` draws all of it from code. Change a word or a proportion and
re-run `python3 make_logo.py`. Text is converted to outlines, so the SVGs
don't depend on anyone having the font installed.
