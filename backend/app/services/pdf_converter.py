import io
from pathlib import Path

from pdf2image import convert_from_bytes
from PIL import Image

from app.config import settings


def pdf_to_images(pdf_bytes: bytes, dpi: int | None = None) -> list[Image.Image]:
    """Convert PDF bytes to a list of PIL images, one per page."""
    render_dpi = dpi or settings.pdf_dpi
    return convert_from_bytes(pdf_bytes, dpi=render_dpi, fmt="png")


def save_images(images: list[Image.Image], output_dir: str, prefix: str) -> list[Path]:
    """Persist rendered page images to disk for debugging or audit."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i, img in enumerate(images):
        path = out / f"{prefix}_page_{i + 1}.png"
        img.save(path, format="PNG")
        paths.append(path)
    return paths


def image_to_bytes(image: Image.Image, fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()
