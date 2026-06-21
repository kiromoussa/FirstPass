import io

import pytest
from PIL import Image

from app.services.dwg_converter import DWG_CONVERSION_ERROR
from app.services.file_converter import file_to_images, is_allowed_extension, save_upload


def test_is_allowed_extension():
    assert is_allowed_extension("plan.pdf")
    assert is_allowed_extension("plan.DWG")
    assert not is_allowed_extension("plan.txt")


def test_save_upload(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.file_converter.settings.upload_dir", str(tmp_path))
    content = b"test content"
    path = save_upload(content, "plan.pdf", "abc-123")
    assert path.exists()
    assert path.read_bytes() == content
    assert path.parent.name == "abc-123"


def test_file_to_images_png(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.file_converter.settings.upload_dir", str(tmp_path))
    buffer = io.BytesIO()
    Image.new("RGB", (10, 10), color="white").save(buffer, format="PNG")
    content = buffer.getvalue()
    saved = save_upload(content, "plan.png", "test-id")

    images = file_to_images(content, "plan.png", saved)
    assert len(images) == 1
    assert images[0].size == (10, 10)


def test_file_to_images_dwg_raises_clear_error(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.file_converter.settings.upload_dir", str(tmp_path))
    content = b"AC1018 placeholder"
    saved = save_upload(content, "plan.dwg", "test-id")

    with pytest.raises(RuntimeError, match=DWG_CONVERSION_ERROR):
        file_to_images(content, "plan.dwg", saved)
