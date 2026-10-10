"""Sample points for the General Staff's directions (`scripts/gsua/`).

The GS reports name a direction, never a place, so this table is a judgement
call in the same way `DIRECTION_AXIS` in src/types/index.ts is: one point per
active direction, placed on or just behind the contact line rather than on the
town the direction is named after (which is often 10–30 km away, and on the
Ukrainian side).

Precision matters less than it looks. The models behind Open-Meteo run on a
2–11 km grid, and fog, frontal rain and wind fields are tens of kilometres
across; a point 10 km off still samples the same weather. Convective summer
showers are the exception — no point placement fixes those.

`names` are the GSUA direction labels (scrape_general_staff.DIRECTION_NAMES)
the point stands for, so a report can be joined onto the attack counts later.
The list is the directions that still carried attacks in the reports of
2026-09/10; re-check it against `gsua_direction_monthly` when the front moves —
the dates below say when each point was last placed.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Sector:
    key: str            # GSUA direction label (the primary one)
    lat: float
    lon: float
    near: str           # what the point is near, for a human reading the table
    names: tuple[str, ...] = ()   # every GSUA label this point stands for
    placed: str = "2026-10"

    @property
    def labels(self) -> tuple[str, ...]:
        return self.names or (self.key,)


# North to south, the order the GS reports run in.
SECTORS: tuple[Sector, ...] = (
    Sector("N-Slobozhanshchyna", 51.17, 35.03, "Yunakivka, Sumy border",
           names=("N-Slobozhanshchyna", "Kursk")),
    Sector("S-Slobozhanshchyna", 50.29, 36.94, "Vovchansk"),
    Sector("Kupiansk", 49.71, 37.62, "Kupiansk"),
    Sector("Lyman", 49.02, 37.92, "Lyman–Kreminna forest"),
    Sector("Sloviansk", 48.87, 37.95, "Siversk–Raihorodok"),
    Sector("Kramatorsk", 48.59, 37.84, "Chasiv Yar"),
    Sector("Kostiantynivka", 48.50, 37.75, "Kostiantynivka SE edge"),
    Sector("Pokrovsk", 48.30, 37.15, "Pokrovsk–Myrnohrad"),
    Sector("Oleksandrivka", 47.97, 36.58, "Dnipropetrovsk/Donetsk border"),
    Sector("Huliaipole", 47.66, 36.26, "Huliaipole"),
    Sector("Orikhiv", 47.57, 35.78, "Orikhiv"),
    Sector("Prydniprovske", 46.63, 32.70, "Dnipro at Kherson"),
)


def find(keys: list[str] | None) -> list[Sector]:
    """Sectors whose key or any GSUA label matches, case-insensitively."""
    if not keys:
        return list(SECTORS)
    wanted = {k.lower() for k in keys}
    hits = [s for s in SECTORS
            if s.key.lower() in wanted or any(n.lower() in wanted for n in s.labels)]
    missing = wanted - {n.lower() for s in hits for n in (s.key, *s.labels)}
    if missing:
        known = ", ".join(s.key for s in SECTORS)
        raise ValueError(f"unknown sector(s): {', '.join(sorted(missing))} (known: {known})")
    return hits
