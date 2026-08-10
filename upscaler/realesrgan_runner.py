"""
Pure Real-ESRGAN upscale — NO face regeneration.

CodeFormer's face restorer re-synthesises the face crop through its codebook,
which drifts identity (e.g. removes stubble) even at fidelity 1.0. For news
photos we use this runner instead: a straight RRDBNet ×2 super-resolve of the
whole frame. Faces stay pixel-derived from the original.

TILING AND SPEED
Tiles bound peak memory, but every tile is padded by tile_pad on each side and
that padding is recomputed for each one — so small tiles do a lot of redundant
work. Measured on an 870x1390 photo (28 cores):

    tile      seconds    peak RSS
    200        107.1      —
    400         71.4      1.2 GB      <- the old hard-coded value
    800         56.2      2.7 GB
    none        48.4      4.3 GB

Fastest is worst for memory, and an OOM kill is a far worse outcome than a
slow response. So the tile is derived from a memory BUDGET instead of being
fixed: small images get one big tile and run fast, large ones get tiled down
until they fit. Thread count barely matters (20 vs 28 threads was within 2%).

Usage: python realesrgan_runner.py <input_image> <output_image>
Run from inside the CodeFormer repo (imports its vendored basicsr).
"""

import math
import os
import sys

import cv2
import torch
from basicsr.archs.rrdbnet_arch import RRDBNet
from basicsr.utils.realesrgan_utils import RealESRGANer

# Peak RSS this process may add on top of its ~280 MB baseline. Default 1536
# leaves room on a small container; raise it on a larger box to go faster.
MEM_BUDGET_MB = int(os.environ.get("UPSCALE_MEM_BUDGET_MB", "1536"))

# Least-squares fit over four measured points (tile 400/670/800/none on an
# 870x1390 photo), predicting within +-67 MB:
#
#     peak_MB = 506 + 3.02 KB/px * tile_pixels
#
# The intercept matters. A first attempt modelled this as pure KB-per-pixel
# with no fixed term and underestimated by 245-365 MB, so a 1536 MB budget
# actually peaked at 1896 MB — 23% over, which is an OOM kill on a container
# sized to the stated budget. FIXED and KB_PER_PIXEL are rounded up from the
# fit so the error lands on the safe side.
FIXED_OVERHEAD_MB = 520
KB_PER_PIXEL = 3.1

# Escape hatch — set a number to pin the tile, or 0 to disable tiling.
TILE_OVERRIDE = os.environ.get("UPSCALE_TILE", "").strip()


def choose_tile(width: int, height: int) -> int:
    """Largest square tile that fits the memory budget. 0 means no tiling."""
    if TILE_OVERRIDE:
        try:
            return max(0, int(TILE_OVERRIDE))
        except ValueError:
            pass

    # Only what is left after the fixed overhead can be spent on tile pixels.
    spendable_mb = MEM_BUDGET_MB - FIXED_OVERHEAD_MB
    if spendable_mb <= 0:
        # Budget below the floor cost of running at all — tile as small as is
        # still sane and let the OOM retry in main() catch it if that fails.
        return 256
    budget_px = (spendable_mb * 1024) / KB_PER_PIXEL
    tile = int(math.sqrt(max(budget_px, 64 * 64)))

    # RRDBNet(scale=2) begins with pixel_unshuffle, which asserts the input is
    # divisible by the scale — an odd tile raises AssertionError deep inside
    # basicsr. Snapping down to a multiple of 8 satisfies that with margin and
    # costs at most 7 pixels of tile. The old hard-coded 400 was even by
    # luck, so this only surfaced once the size became computed.
    tile -= tile % 8

    # Tiling bigger than the image itself buys nothing, and RealESRGANer
    # treats 0 as "process the whole frame", which skips the padding work
    # entirely — the fastest path when it fits.
    if tile >= max(width, height):
        return 0
    # Below this, padding overhead dominates and it is slower AND uglier.
    return max(tile, 256)


def main() -> int:
    inp, outp = sys.argv[1], sys.argv[2]

    img = cv2.imread(inp, cv2.IMREAD_COLOR)
    if img is None:
        print("could not read input", file=sys.stderr)
        return 1

    h, w = img.shape[:2]
    tile = choose_tile(w, h)
    torch.set_num_threads(os.cpu_count() or 4)
    print(f"upscaling {w}x{h} tile={tile or 'none'} budget={MEM_BUDGET_MB}MB", file=sys.stderr)

    model = RRDBNet(
        num_in_ch=3, num_out_ch=3, num_feat=64,
        num_block=23, num_grow_ch=32, scale=2,
    )
    upsampler = RealESRGANer(
        scale=2,
        model_path="weights/realesrgan/RealESRGAN_x2plus.pth",
        model=model,
        tile=tile,
        tile_pad=40,
        pre_pad=0,
        half=False,        # CPU
    )

    try:
        output, _ = upsampler.enhance(img, outscale=2)
    except (RuntimeError, MemoryError) as exc:
        # Out of memory despite the budget — retry once, tiled hard. Better a
        # slow success than a failed request.
        print(f"retrying with small tiles after: {exc}", file=sys.stderr)
        upsampler.tile = 256
        output, _ = upsampler.enhance(img, outscale=2)

    return 0 if cv2.imwrite(outp, output) else 1


if __name__ == "__main__":
    sys.exit(main())
