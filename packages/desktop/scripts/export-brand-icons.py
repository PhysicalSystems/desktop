"""Export the approved transparent workcell artwork. Requires Pillow 10.4+."""

from pathlib import Path

from PIL import Image


directory = Path(__file__).resolve().parents[1] / "icons" / "physicalsystems"
source = Image.open(directory / "source.png").convert("RGBA")
# Ignore barely visible generation residue when measuring the artwork, while
# preserving the original pixels and antialiasing inside the resulting crop.
bounds = source.getchannel("A").point(lambda value: 255 if value > 32 else 0).getbbox()
if bounds is None:
    raise ValueError("The source contains no visible artwork")
artwork = source.crop(bounds)


def raster(size):
    result = Image.new("RGBA", (size, size))
    symbol = artwork.copy()
    inset = max(1, round(size * 0.04))
    symbol.thumbnail((size - 2 * inset, size - 2 * inset), Image.Resampling.LANCZOS)
    result.alpha_composite(symbol, ((size - symbol.width) // 2, (size - symbol.height) // 2))
    return result


for size in (16, 24, 32, 48, 64, 128, 180, 256, 512, 1024):
    raster(size).save(directory / f"{size}x{size}.png", optimize=True)
raster(1024).save(directory / "icon.png", optimize=True)
raster(1024).save(directory / "dock.png", optimize=True)
raster(256).save(directory / "icon.ico", sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
raster(1024).save(directory / "icon.icns")
print(f"Exported transparent icons from {source.size}, artwork bounds {bounds}")
