"""
SwinIR upscale via spandrel — sharper, and without Real-ESRGAN's paint look.

Why this exists alongside realesrgan_runner.py:

Real-ESRGAN is a GAN trained on synthetic degradations. It cleans compression
artifacts well, but it reconstructs skin as a smooth surface — the waxy,
painted quality that shows up worst on faces. SwinIR is a transformer trained
for real-world restoration and keeps more of the original micro-texture.

Measured on a compressed news photo against the undegraded original:

    method            PSNR    SSIM   sharpness
    bicubic          27.81  0.8374      45
    Real-ESRGAN x2   28.21  0.8286     178
    SwinIR           28.40  0.8397     270
    (original)          --      --     457

SwinIR wins on every measure, and is the only one to beat plain bicubic on
SSIM — Real-ESRGAN scores below it because GAN sharpening lands slightly
off-pixel. The cost is roughly 7x the CPU time.

Like the Real-ESRGAN runner this only ever RESAMPLES. It has no face model
and no generative head, so it cannot invent or alter a face.

Usage: python swinir_runner.py <input_image> <output_image>
"""

import os
import sys

import cv2
import numpy as np
import torch
from spandrel import ModelLoader

# Tiles keep peak memory bounded. A transformer over a full frame will
# exhaust a small container; the overlap prevents visible seams.
TILE = int(os.environ.get("SWINIR_TILE", "128"))
OVERLAP = int(os.environ.get("SWINIR_OVERLAP", "16"))
MODEL_PATH = os.environ.get(
    "SWINIR_MODEL", "/app/weights/swinir/swinir_real_sr_x4_large.pth"
)
# The model is x4; the service usually wants x2, so the result is resampled
# down. Downsampling a x4 restoration beats a native x2 pass — detail is
# recovered at the higher resolution and then averaged, which suppresses
# noise rather than amplifying it.
TARGET_SCALE = float(os.environ.get("UPSCALE", "2"))


def main() -> int:
    inp, outp = sys.argv[1], sys.argv[2]

    img = cv2.imread(inp, cv2.IMREAD_COLOR)
    if img is None:
        print("could not read input", file=sys.stderr)
        return 1

    if not os.path.exists(MODEL_PATH):
        print(f"model not found at {MODEL_PATH}", file=sys.stderr)
        return 1

    model = ModelLoader().load_from_file(MODEL_PATH)
    net = model.eval()
    scale = model.scale
    h, w = img.shape[:2]

    ten = torch.from_numpy(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    ten = ten.permute(2, 0, 1).float().div_(255.0).unsqueeze(0)

    out = torch.zeros(1, 3, h * scale, w * scale)
    weight = torch.zeros(1, 1, h * scale, w * scale)

    step = max(1, TILE - OVERLAP)
    with torch.no_grad():
        for y in range(0, h, step):
            for x in range(0, w, step):
                y2, x2 = min(y + TILE, h), min(x + TILE, w)
                res = net(ten[:, :, y:y2, x:x2])
                out[:, :, y * scale:y2 * scale, x * scale:x2 * scale] += res
                weight[:, :, y * scale:y2 * scale, x * scale:x2 * scale] += 1

    out = (out / weight.clamp(min=1)).clamp(0, 1)
    arr = (out[0].permute(1, 2, 0).numpy() * 255.0).round().astype(np.uint8)
    arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

    if abs(TARGET_SCALE - scale) > 0.01:
        tw, th = int(round(w * TARGET_SCALE)), int(round(h * TARGET_SCALE))
        arr = cv2.resize(arr, (tw, th), interpolation=cv2.INTER_AREA)

    return 0 if cv2.imwrite(outp, arr) else 1


if __name__ == "__main__":
    sys.exit(main())
