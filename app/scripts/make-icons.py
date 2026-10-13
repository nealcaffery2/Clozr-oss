#!/usr/bin/env python3
"""
Rasterise public/favicon.svg into the Home Screen icons the web app manifest
and iOS ask for (public/apple-touch-icon.png, icon-192.png, icon-512.png,
icon-maskable-512.png).

    cd app && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers python3 scripts/make-icons.py

Every icon is opaque: iOS composites any transparency onto black. The mark sits
on white at 62% of the tile (50% for the maskable one, inside the central
safe zone a launcher may crop to). Chromium (Python Playwright) draws the SVG;
if it is not available the four rounded squares are drawn with Pillow from
the same coordinates.
"""

import base64
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, '..', 'public')
SVG = os.path.join(PUBLIC, 'favicon.svg')

# (file, size, share of the tile the mark fills)
ICONS = [
    ('apple-touch-icon.png', 180, 0.62),
    ('icon-192.png', 192, 0.62),
    ('icon-512.png', 512, 0.62),
    ('icon-maskable-512.png', 512, 0.50),
]

# favicon.svg's four squares (x0, y0, x1, y1, fill) in its 24-unit box, for the fallback.
SQUARES = [
    (12, 12, 22, 22, '#68C4FF'),
    (15, 2, 22, 9, '#0C79D8'),
    (2, 15, 9, 22, '#0C79D8'),
    (2, 2, 12, 12, '#2E9EFF'),
]


def flatten(path):
    """Drop any alpha channel so the icon is opaque."""
    Image.open(path).convert('RGB').save(path, optimize=True)


def with_chromium():
    from playwright.sync_api import sync_playwright

    data = base64.b64encode(open(SVG, 'rb').read()).decode()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, size, share in ICONS:
            page = browser.new_page(viewport={'width': size, 'height': size}, device_scale_factor=1)
            mark = round(size * share)
            page.set_content(
                '<body style="margin:0;background:#FFFFFF;width:%dpx;height:%dpx;display:grid;place-items:center">'
                '<img src="data:image/svg+xml;base64,%s" width="%d" height="%d"></body>' % (size, size, data, mark, mark)
            )
            page.wait_for_load_state('load')
            out = os.path.join(PUBLIC, name)
            page.screenshot(path=out, omit_background=False)
            page.close()
            flatten(out)
            print('wrote', out)
        browser.close()


def with_pillow():
    for name, size, share in ICONS:
        img = Image.new('RGB', (size, size), '#FFFFFF')
        draw = ImageDraw.Draw(img)
        scale = size * share / 20  # the mark spans x/y 2..22 of the 24-unit box
        off = (size - size * share) / 2
        for x0, y0, x1, y1, fill in SQUARES:
            box = [off + (x0 - 2) * scale, off + (y0 - 2) * scale, off + (x1 - 2) * scale, off + (y1 - 2) * scale]
            draw.rounded_rectangle(box, radius=2.7 * scale, fill=fill)
        out = os.path.join(PUBLIC, name)
        img.save(out, optimize=True)
        print('wrote', out, '(pillow fallback)')


if __name__ == '__main__':
    try:
        with_chromium()
    except Exception as err:  # no Playwright or no browser: draw it instead
        print('chromium unavailable (%s); using the Pillow fallback' % err, file=sys.stderr)
        with_pillow()
