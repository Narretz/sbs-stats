#!/usr/bin/env python3
"""
download_foosint_db.py
----------------------
Downloads the foosint sbs.db snapshot from GitHub to data/sbs-foosint.db.
"""

import time
import requests
from pathlib import Path

URL = "https://raw.githubusercontent.com/foosint/sbs-stats/main/data/sbs.db"
DEST = Path("data/sbs-foosint.db")


def main() -> None:
    bust = int(time.time())
    url = f"{URL}?bust={bust}"
    DEST.parent.mkdir(parents=True, exist_ok=True)

    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        with DEST.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 16):
                f.write(chunk)

    print(f"Downloaded {DEST} ({DEST.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
