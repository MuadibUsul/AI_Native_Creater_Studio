#!/usr/bin/env python3
"""Exact, unmasked Pillow comparison. Output images and JSON stay under .artifacts."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops


def main(reference_path: str, actual_path: str, output_path: str) -> None:
    artifact_root = (Path(__file__).resolve().parents[1] / ".artifacts").resolve()
    output = Path(output_path).resolve()
    if not output.is_relative_to(artifact_root):
        raise ValueError("Diff output must stay inside .artifacts")
    for name in ("overlay.png", "diff.png"):
        if (output / name).exists():
            raise FileExistsError(f"Evidence already exists: {output / name}")

    with Image.open(reference_path) as source:
        reference = source.convert("RGB")
    with Image.open(actual_path) as source:
        actual = source.convert("RGB")
    width = max(reference.width, actual.width)
    height = max(reference.height, actual.height)
    if width * height > 100_000_000:
        raise ValueError("Comparison exceeds 100 million pixels")

    ref_canvas = Image.new("RGB", (width, height), "white")
    actual_canvas = Image.new("RGB", (width, height), "white")
    ref_canvas.paste(reference, (0, 0))
    actual_canvas.paste(actual, (0, 0))
    ref_present = Image.new("L", (width, height), 0)
    actual_present = Image.new("L", (width, height), 0)
    ref_present.paste(255, (0, 0, reference.width, reference.height))
    actual_present.paste(255, (0, 0, actual.width, actual.height))

    delta = ImageChops.difference(ref_canvas, actual_canvas)
    red, green, blue = delta.split()
    color_mask = ImageChops.lighter(ImageChops.lighter(red, green), blue).point(lambda value: 255 if value else 0)
    presence_mask = ImageChops.difference(ref_present, actual_present)
    mask = ImageChops.lighter(color_mask, presence_mask)
    union = ImageChops.lighter(ref_present, actual_present)
    differing = mask.histogram()[255]
    total = union.histogram()[255]
    missing_area = presence_mask.histogram()[255]

    Image.blend(ref_canvas, actual_canvas, 0.5).save(output / "overlay.png")
    highlighted = Image.new("RGB", (width, height), "black")
    highlighted.paste((255, 64, 64), mask=mask)
    highlighted.save(output / "diff.png")
    print(json.dumps({
        "comparison": "exact RGB, zero tolerance, no mask or crop",
        "referencePixels": [reference.width, reference.height],
        "actualPixels": [actual.width, actual.height],
        "canvasPixels": [width, height],
        "unionPixels": total,
        "differentPixels": differing,
        "differentRatio": differing / total if total else 0,
        "missingAreaPixels": missing_area,
        "maxChannelDelta": max(channel[1] for channel in delta.getextrema()),
    }))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: python scripts/quiet-frame-diff.py REFERENCE.png ACTUAL.png OUTPUT_DIR")
    main(*sys.argv[1:])
