"""Experiment-only bridge; keep Paddle generated-code cache inside the workspace."""
import os
from pathlib import Path
import runpy

from paddle.jit.dy2static import utils

root = Path(__file__).resolve().parents[1]
cache = root / "tmp" / "local-uie-test" / "generated-code" / str(os.getpid())
cache.mkdir(parents=True, exist_ok=True)
# Paddle 3.3 hard-codes ~/.cache here. Override only in this isolated test process.
utils.get_temp_dir = lambda: str(cache)
runpy.run_path(str(root / "packages" / "memory" / "resources" / "uie_extract.py"), run_name="__main__")
