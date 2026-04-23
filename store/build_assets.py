#!/usr/bin/env python3
"""Rebuild Chrome Web Store listing PNGs from files in ./sources/."""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sources"
PREFIX = "nhl"
ICON_SRC = HERE.parent / "icons" / "icon128.png"


def cover_resize(im: Image.Image, w: int, h: int) -> Image.Image:
    im = im.convert("RGB")
    sw, sh = im.size
    scale = max(w / sw, h / sh)
    nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (im.size[0] - w) // 2
    top = (im.size[1] - h) // 2
    return im.crop((left, top, left + w, top + h))


def listing_icon_128(src_icon: Path, out_path: Path) -> None:
    im = Image.open(src_icon).convert("RGBA")
    im.thumbnail((96, 96), Image.Resampling.LANCZOS)
    w, h = im.size
    canvas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    canvas.paste(im, ((128 - w) // 2, (128 - h) // 2), im)
    canvas.save(out_path, "PNG")


def main() -> None:
    promo_in = SOURCES / f"{PREFIX}-promo-source.png"
    shot_in = SOURCES / f"{PREFIX}-screenshot-source.png"
    cover_resize(Image.open(promo_in), 440, 280).save(HERE / "promo-small-440x280.png", "PNG")
    cover_resize(Image.open(promo_in), 1400, 560).save(HERE / "promo-marquee-1400x560.png", "PNG")
    cover_resize(Image.open(shot_in), 1280, 800).save(HERE / "screenshot-01-1280x800.png", "PNG")
    listing_icon_128(ICON_SRC, HERE / "icon-128-listing.png")
    print("Updated", HERE)


if __name__ == "__main__":
    main()
