// fetch-vigilance.mjs
// Récupère les flux Atom publics MeteoAlarm (EUMETNET) pour une liste de pays
// européens, filtre les alertes actives, les agrège par pays et par type
// d'aléa, et écrit data.json à la racine pour publication via GitHub Pages.
//
// Aucune clé API requise — flux publics MeteoAlarm (feeds.meteoalarm.org).

import { writeFile } from 'fs/promises';

// Pays couverts : { code ISO, libellé FR, slug du flux MeteoAlarm }
const COUNTRIES = [
  { code: 'FR', name_fr: 'France', slug: 'france' },
  { code: 'BE', name_fr: 'Belgique', slug: 'belgium' },
  { code: 'ES', name_fr: 'Espagne', slug: 'spain' },
  { code: 'IT', name_fr: 'Italie', slug: 'italy' },
  { code: 'DE', name_fr: 'Allemagne', slug: 'germany' },
  { code: 'PT', name_fr: 'Portugal', slug: 'portugal' },
  { code: 'CH', name_fr: 'Suisse', slug: 'switzerland' },
  { code: 'AT', name_fr: 'Autriche', slug: 'austria' },
  { code: 'NL', name_fr: 'Pays-Bas', slug: 'netherlands' },
  { code: 'GB', name_fr: 'Royaume-Uni', slug: 'united-kingdom' },
  { code: 'IE', name_fr: 'Irlande', slug: 'ireland' },
  { code: 'LU', name_fr: 'Luxembourg', slug: 'luxembourg' },
];

const HEADERS = {
  'User-Agent': 'petrol-vigilance-trmnl-bot/1.0 (+https://github.com/nbbou81000)',
};

// Sévérité MeteoAlarm -> rang / couleur / libellé FR
const SEVERITY_MAP = {
  Minor: { rank: 1, color: 'green', label: 'Vert' },
  Moderate: { rank: 2, color: 'yellow', label: 'Jaune' },
  Severe: { rank: 3, color: 'orange', label: 'Orange' },
  Extreme: { rank: 4, color: 'red', label: 'Rouge' },
};

function unescapeXml(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? unescapeXml(m[1].trim()) : null;
}

// "Moderate high-temperature warning" -> "high-temperature"
function hazardTypeFromEvent(event) {
  if (!event) return 'unknown';
  return event
    .replace(/^(minor|moderate|severe|extreme)\s+/i, '')
    .replace(/\s+warning$/i, '')
    .trim()
    .toLowerCase();
}

// Libellés FR pour les types d'aléa les plus courants (fallback: valeur brute)
const HAZARD_LABELS_FR = {
  wind: 'Vent',
  'snow-ice': 'Neige / Verglas',
  thunderstorm: 'Orages',
  fog: 'Brouillard',
  'high-temperature': 'Canicule',
  'low-temperature': 'Grand froid',
  coastalevent: 'Événement côtier',
  'forest-fire': 'Feu de forêt',
  avalanches: 'Avalanches',
  rain: 'Pluie',
  flooding: 'Inondation',
  'rain-flood': 'Pluie-inondation',
  'marine-hazard': 'Risque marin',
  drought: 'Sécheresse',
};

async function fetchCountryFeed(slug) {
  const url = `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-${slug}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`MeteoAlarm HTTP ${res.status} pour ${slug}`);
  }
  return res.text();
}

function parseEntries(xml) {
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const now = Date.now();

  return entryBlocks
    .map((block) => {
      const areaDesc = extractTag(block, 'cap:areaDesc');
      const severity = extractTag(block, 'cap:severity');
      const event = extractTag(block, 'cap:event');
      const onset = extractTag(block, 'cap:onset');
      const effective = extractTag(block, 'cap:effective');
      const expires = extractTag(block, 'cap:expires');

      return { areaDesc, severity, event, onset, effective, expires };
    })
    .filter((e) => e.severity && SEVERITY_MAP[e.severity])
    .filter((e) => {
      // Ne garder que les alertes actuellement actives (pas encore expirées)
      if (!e.expires) return true;
      const expiresMs = Date.parse(e.expires);
      return Number.isNaN(expiresMs) || expiresMs > now;
    });
}

function aggregateCountry(entries) {
  if (entries.length === 0) {
    return {
      max_level: 'green',
      max_level_label: 'Vert',
      active_zone_count: 0,
      hazards: [],
    };
  }

  // Par type d'aléa, on garde un Set de zones DISTINCT PAR NIVEAU de sévérité,
  // pour ne jamais mélanger le compte de zones "rouge" avec celui des zones
  // "orange"/"jaune" du même aléa.
  const byType = new Map();
  let maxRank = 1;

  for (const e of entries) {
    const type = hazardTypeFromEvent(e.event);
    const sev = SEVERITY_MAP[e.severity];
    maxRank = Math.max(maxRank, sev.rank);

    if (!byType.has(type)) {
      byType.set(type, new Map()); // rank -> Set(zones)
    }
    const levels = byType.get(type);
    if (!levels.has(sev.rank)) levels.set(sev.rank, new Set());
    if (e.areaDesc) levels.get(sev.rank).add(e.areaDesc);
  }

  const rankToInfo = Object.fromEntries(
    Object.values(SEVERITY_MAP).map((v) => [v.rank, v])
  );

  const hazards = Array.from(byType.entries())
    .map(([type, levels]) => {
      const topRank = Math.max(...levels.keys());
      const topZones = levels.get(topRank);
      // total de zones touchées par cet aléa, tous niveaux confondus (info secondaire)
      const totalZones = new Set([...levels.values()].flatMap((s) => [...s])).size;
      return {
        type,
        label_fr: HAZARD_LABELS_FR[type] || type,
        level: rankToInfo[topRank].color,
        level_label: rankToInfo[topRank].label,
        zone_count: topZones.size, // zones AU niveau le plus élevé uniquement
        total_zone_count: totalZones, // toutes zones touchées, tous niveaux
      };
    })
    .sort((a, b) => {
      const rankA = Object.values(SEVERITY_MAP).find((v) => v.color === a.level).rank;
      const rankB = Object.values(SEVERITY_MAP).find((v) => v.color === b.level).rank;
      if (rankB !== rankA) return rankB - rankA;
      return b.zone_count - a.zone_count;
    });

  const distinctZones = new Set(entries.map((e) => e.areaDesc).filter(Boolean));

  return {
    max_level: rankToInfo[maxRank].color,
    max_level_label: rankToInfo[maxRank].label,
    active_zone_count: distinctZones.size,
    hazards,
  };
}

async function buildCountry(country) {
  try {
    const xml = await fetchCountryFeed(country.slug);
    const entries = parseEntries(xml);
    const agg = aggregateCountry(entries);
    return {
      code: country.code,
      name_fr: country.name_fr,
      ok: true,
      ...agg,
    };
  } catch (err) {
    console.error(`Erreur pour ${country.name_fr} (${country.slug}):`, err.message);
    return {
      code: country.code,
      name_fr: country.name_fr,
      ok: false,
      max_level: 'unknown',
      max_level_label: 'Indisponible',
      active_zone_count: 0,
      hazards: [],
    };
  }
}

async function main() {
  const results = await Promise.all(COUNTRIES.map(buildCountry));

  const byCode = {};
  for (const r of results) {
    byCode[r.code] = r;
  }

  const data = {
    generated_at: new Date().toISOString(),
    countries: byCode,
  };

  await writeFile('data.json', JSON.stringify(data, null, 2));
  console.log('data.json écrit. Résumé :');
  for (const r of results) {
    console.log(
      `  ${r.code} (${r.name_fr}): ${r.max_level_label} — ${r.hazards.length} type(s) d'aléa, ${r.active_zone_count} zone(s)`
    );
  }
}

main().catch((err) => {
  console.error('Erreur fetch-vigilance:', err);
  process.exit(1);
});
