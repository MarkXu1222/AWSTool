#!/usr/bin/env python3
"""Local PP-OCRv6 recognition. PNG on stdin; one JSON result on stdout. No artifacts."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys


def main():
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import rapidocr
        from rapidocr import RapidOCR, OCRVersion, ModelType, LangRec
        from PIL import Image, ImageFilter, ImageOps

        model = Path(rapidocr.__file__).parent / "models/PP-OCRv6_rec_small.onnx"
        if not model.is_file():
            raise ValueError("OCR weights missing; run the documented model setup first")
        if hashlib.sha256(model.read_bytes()).hexdigest() != "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884":
            raise ValueError("OCR model checksum mismatch")
        if "--check" in sys.argv:
            print(json.dumps({"ready": True}), file=sys.__stdout__)
            return
        data = sys.stdin.buffer.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError("Image too large")
        with Image.open(io.BytesIO(data)) as opened:
            if opened.width > 800 or opened.height > 400:
                raise ValueError("Expected a cropped CAPTCHA")
            dark = ImageOps.grayscale(opened).point(lambda p: 255 if p > 25 else 0)
        engine = RapidOCR(params={
            "Global.use_det": False, "Global.use_cls": False, "Global.use_rec": True,
            "Global.text_score": 0.0, "Global.log_level": "error",
            "EngineConfig.onnxruntime.intra_op_num_threads": 2,
            "EngineConfig.onnxruntime.inter_op_num_threads": 2,
            "Rec.ocr_version": OCRVersion.PPOCRV6, "Rec.model_type": ModelType.SMALL,
            "Rec.lang_type": LangRec.EN, "Rec.model_path": str(model),
        })
        outputs = []
        for size in (3, 5):
            image = dark.filter(ImageFilter.MedianFilter(size)).convert("RGB")
            result = engine(np.asarray(image)[:, :, ::-1], use_det=False, use_cls=False, use_rec=True)
            outputs.append("".join("".join(result.txts or []).split()))
        candidate = outputs[0] if outputs[0] == outputs[1] and len(outputs[0]) == 6 and outputs[0].isascii() and outputs[0].isalnum() else None
    print(json.dumps({"candidate": candidate}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "Local OCR unavailable"}))
        sys.exit(1)
