"""Restore byte-exact assets transported through the text-only GitHub MCP."""
import base64
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets = json.loads((root / "binary-assets.json").read_text(encoding="utf-8"))
for name, asset in assets.items():
    target = (root / name).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError(f"Invalid asset path: {name}")
    data = base64.b64decode(asset["base64"], validate=True)
    if hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise ValueError(f"Asset checksum mismatch: {name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    print(f"Restored {name}: {len(data)} bytes, SHA256 {asset['sha256']}")
