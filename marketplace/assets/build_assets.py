"""Seat Reclaim for Confluence logo and banners, in the License Audit family: navy tile, nine
seats, one seat taken back (a green return arrow instead of License Audit's ring).
Run: python3 build_assets.py  (writes PNGs next to this file)"""
import math, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
NAVY = (11, 34, 57)
WHITE = (255, 255, 255)
GREEN = (0, 143, 168)
MINT = (121, 216, 232)
S = 4  # supersampling


def arrow_seat(d, cx, cy, r, w):
    """A circular 'take back' arrow centred on (cx, cy)."""
    box = (cx - r, cy - r, cx + r, cy + r)
    d.arc(box, start=-60, end=230, fill=GREEN, width=w)
    a = math.radians(-60)  # arrowhead at the arc's start, pointing along the turn
    ex, ey = cx + r * math.cos(a), cy + r * math.sin(a)
    tx, ty = -math.sin(a), math.cos(a)  # tangent (clockwise)
    nx, ny = math.cos(a), math.sin(a)    # outward normal
    h = w * 2.1
    tip = (ex - tx * h * 1.05, ey - ty * h * 1.05)
    d.polygon([tip, (ex + nx * h, ey + ny * h), (ex - nx * h, ey - ny * h)], fill=GREEN)
    d.ellipse((cx - r * 0.34, cy - r * 0.34, cx + r * 0.34, cy + r * 0.34), fill=MINT)


def grid(d, x0, y0, step, dot, arrow_r, arrow_w):
    for row in range(3):
        for col in range(3):
            cx, cy = x0 + col * step, y0 + row * step
            if (row, col) == (1, 2):
                arrow_seat(d, cx, cy, arrow_r, arrow_w)
            else:
                d.ellipse((cx - dot, cy - dot, cx + dot, cy + dot), fill=WHITE)


def logo(size):
    n = size * S
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.2), fill=NAVY)
    step = n * 0.31
    grid(d, n * 0.19, n * 0.19, step, n * 0.085, n * 0.135, int(n * 0.034))
    return im.resize((size, size), Image.LANCZOS)


def font(bold, px):
    names = ['Arial Bold.ttf', 'Arial.ttf'] if bold else ['Arial.ttf']
    for name in names:
        p = f'/System/Library/Fonts/Supplemental/{name}'
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def banner(w, h):
    n_w, n_h = w * S, h * S
    im = Image.new('RGB', (n_w, n_h), NAVY)
    d = ImageDraw.Draw(im)
    for x in range(-n_h, n_w, 9 * S):  # faint diagonal texture, as on License Audit
        d.line((x, n_h, x + n_h, 0), fill=(16, 41, 66), width=S)
    u = n_h / 548  # layout unit relative to the 1120x548 design
    gx = n_w * 0.148 if w / h > 1.8 else n_w * 0.12
    grid(d, gx, n_h / 2 - 93 * u, 93 * u, 26 * u, 41 * u, int(8 * u))
    tx = n_w * 0.42
    d.text((tx, n_h * 0.27), 'Seat Reclaim', font=font(True, int(72 * u)), fill=WHITE)
    d.text((tx, n_h * 0.42), 'for Confluence', font=font(False, int(42 * u)), fill=MINT)
    d.text((tx, n_h * 0.57), 'Free the Confluence seats nobody uses.', font=font(False, int(28 * u)), fill=(214, 222, 232))
    d.text((tx, n_h * 0.655), 'Confirm first. Confluence confirms. Undo any change.', font=font(False, int(28 * u)), fill=(214, 222, 232))
    d.rectangle((tx, n_h * 0.75, tx + 72 * u, n_h * 0.75 + 5 * u), fill=GREEN)
    d.text((tx, n_h * 0.79), 'RUNS ON ATLASSIAN  ·  NO EXTERNAL SERVERS', font=font(False, int(16 * u)), fill=(150, 170, 192))
    return im.resize((w, h), Image.LANCZOS)


for size in (144, 512, 1024):
    logo(size).save(os.path.join(HERE, f'logo-{size}.png'))
banner(1120, 548).save(os.path.join(HERE, 'banner-1120x548.png'))
banner(1920, 1200).save(os.path.join(HERE, 'banner-1920x1200.png'))
print('done')
