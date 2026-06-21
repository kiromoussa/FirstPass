import io
from pathlib import Path

from PIL import Image

from app.config import settings
from app.services.dwg_converter import DWG_CONVERSION_ERROR, dwg_to_png
from app.services.pdf_converter import pdf_to_images

ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".dwg"}


def get_extension(filename: str) -> str:
    return Path(filename).suffix.lower()


def is_allowed_extension(filename: str) -> bool:
    return get_extension(filename) in ALLOWED_EXTENSIONS


def save_upload(content: bytes, filename: str, analysis_id: str) -> Path:
    """Persist the uploaded file under uploads/{analysis_id}/."""
    dest_dir = Path(settings.upload_dir) / analysis_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / Path(filename).name
    dest_path.write_bytes(content)
    return dest_path


def validate_file_content(content: bytes, extension: str) -> None:
    if not content:
        raise ValueError("Uploaded file is empty.")

    if extension == ".pdf" and not content.startswith(b"%PDF"):
        raise ValueError("Invalid PDF file.")
    if extension == ".png" and not content.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Invalid PNG file.")
    if extension in {".jpg", ".jpeg"} and not content.startswith(b"\xff\xd8"):
        raise ValueError("Invalid JPEG file.")


def file_to_images(content: bytes, filename: str, saved_path: Path) -> list[Image.Image]:
    """Convert an uploaded floor plan file to PNG image(s) for vision analysis."""
    extension = get_extension(filename)
    validate_file_content(content, extension)

    if extension == ".pdf":
        return pdf_to_images(content)

    if extension in {".png", ".jpg", ".jpeg"}:
        with Image.open(io.BytesIO(content)) as image:
            return [image.convert("RGB")]

    if extension == ".dwg":
        try:
            return [dwg_to_png(saved_path)]
        except RuntimeError as exc:
            if str(exc) == DWG_CONVERSION_ERROR:
                raise
            raise RuntimeError(DWG_CONVERSION_ERROR) from exc

    supported = ", ".join(sorted(ALLOWED_EXTENSIONS))
    raise ValueError(f"Unsupported file type. Supported formats: {supported}")
