// The regions an RU MoD report names, for the daily charts' tooltips. The
// ingest stores each one under a single Russian spelling, the genitive of "над
// территорией …" (scripts/ru_mod/ingest.py canonical_region); shown here by
// its English name. A name not listed shows as stored.
//
// Until spring 2026 the MoD often gave a count per region; since April 2026 it
// only lists them after one total, so a region's `drones` is null.

const EN: Record<string, string> = {
  "Азовского моря": "Sea of Azov",
  "Азовского и Черного морей": "Sea of Azov + Black Sea",
  "Архангельской области": "Arkhangelsk",
  "Астраханской области": "Astrakhan",
  "Белгородской области": "Belgorod",
  "Брянской области": "Bryansk",
  "Владимирской области": "Vladimir",
  "Волгоградской области": "Volgograd",
  "Вологодской области": "Vologda",
  "Воронежской области": "Voronezh",
  "Ивановской области": "Ivanovo",
  "Кабардино-Балкарской Республики": "Kabardino-Balkaria",
  "Калужской области": "Kaluga",
  "Каспийского моря": "Caspian Sea",
  "Кировской области": "Kirov",
  "Костромской области": "Kostroma",
  "Краснодарского края": "Krasnodar Krai",
  "Курской области": "Kursk",
  "Ленинградской области": "Leningrad",
  "Липецкой области": "Lipetsk",
  "Москвы": "Moscow (city)",
  "Московского региона": "Moscow region",
  "Московской области": "Moscow Oblast",
  "Мурманской области": "Murmansk",
  "Нижегородской области": "Nizhny Novgorod",
  "Новгородской области": "Novgorod",
  "Омской области": "Omsk",
  "Оренбургской области": "Orenburg",
  "Орловской области": "Oryol",
  "Пензенской области": "Penza",
  "Пермского края": "Perm Krai",
  "Псковской области": "Pskov",
  "Республики Абхазия": "Abkhazia",
  "Республики Адыгея": "Adygea",
  "Республики Башкортостан": "Bashkortostan",
  "Республики Дагестан": "Dagestan",
  "Республики Ингушетия": "Ingushetia",
  "Республики Калмыкия": "Kalmykia",
  "Республики Коми": "Komi",
  "Республики Крым": "Crimea",
  "Республики Марий Эл": "Mari El",
  "Республики Мордовия": "Mordovia",
  "Республики Северная Осетия-Алания": "North Ossetia",
  "Республики Татарстан": "Tatarstan",
  "Ростовской области": "Rostov",
  "Рязанской области": "Ryazan",
  "Самарской области": "Samara",
  "Санкт-Петербурга": "St Petersburg",
  "Саратовской области": "Saratov",
  "Свердловской области": "Sverdlovsk",
  "Смоленской области": "Smolensk",
  "Ставропольского края": "Stavropol Krai",
  "Тамбовской области": "Tambov",
  "Тверской области": "Tver",
  "Тульской области": "Tula",
  "Тюменской области": "Tyumen",
  "Удмуртской Республики": "Udmurtia",
  "Ульяновской области": "Ulyanovsk",
  "Ханты-Мансийского автономного округа": "Khanty-Mansi",
  "Челябинской области": "Chelyabinsk",
  "Черного моря": "Black Sea",
  "Черного моря и Республики Крым": "Black Sea + Crimea",
  "Чеченской Республики": "Chechnya",
  "Чувашской Республики": "Chuvashia",
  "Ямало-Ненецкого автономного округа": "Yamalo-Nenets",
  "Ярославской области": "Yaroslavl",
};

export const regionName = (ru: string): string => EN[ru] ?? ru;

export interface RegionMention {
  region: string;
  /** The region's count, or null when a report named it without one. */
  drones: number | null;
}

export interface RegionTotal {
  region: string;
  /** What the reports that counted it add up to; null when none did. */
  drones: number | null;
  /** Some report named it without a count, so `drones` is only a floor. */
  lowerBound: boolean;
}

/** Mentions of the same region in several reports as one. */
export function mergeMentions(mentions: readonly RegionMention[]): RegionTotal[] {
  const by = new Map<string, RegionTotal>();
  for (const m of mentions) {
    const t = by.get(m.region) ?? { region: m.region, drones: null, lowerBound: false };
    if (m.drones == null) t.lowerBound = true;
    else t.drones = (t.drones ?? 0) + m.drones;
    by.set(m.region, t);
  }
  return [...by.values()].map((t) => ({ ...t, lowerBound: t.lowerBound && t.drones != null }));
}

export interface RegionList {
  /** "3 Regions" */
  heading: string;
  /** Counted ones first by count ("≥ 14" when only a floor), then the rest by
   *  name with no value. */
  items: { name: string; value: string | null }[];
}

/** A day's (or window's) regions for the tooltip; null when none were named. */
export function regionList(mentions: readonly RegionMention[]): RegionList | null {
  const merged = mergeMentions(mentions).map((m) => ({ ...m, name: regionName(m.region) }));
  if (!merged.length) return null;
  merged.sort((a, b) =>
    (b.drones ?? -1) - (a.drones ?? -1) || a.name.localeCompare(b.name));
  return {
    heading: `${merged.length} Regions`,
    items: merged.map((m) => ({
      name: m.name,
      value: m.drones == null ? null : `${m.lowerBound ? "≥ " : ""}${m.drones.toLocaleString()}`,
    })),
  };
}
