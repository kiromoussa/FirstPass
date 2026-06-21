from pathlib import Path

from PIL import Image

DWG_CONVERSION_ERROR = (
    "DWG conversion requires LibreDWG/ODA/AutoCAD conversion support. "
    "Please upload PDF or PNG for now."
)


def dwg_to_png(dwg_path: Path, output_path: Path | None = None) -> Image.Image:
    """
    Convert a DWG file to a PNG preview image.

    Placeholder: real conversion requires LibreDWG, ODA File Converter, or AutoCAD.
    """
    raise RuntimeError(DWG_CONVERSION_ERROR)
