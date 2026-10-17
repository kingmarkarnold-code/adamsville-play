# Map data inventory — deep dive, 2026-10-14

Everything below is clipped to the REVISED border (Joshua, 2026-10-14):
NW Zaxby's pinpoint (library 100 yd inside) → NE Piedmont & Monroe →
SE Taylor & Flint River → SW Wendy's on Senoia Rd.

Source: OpenStreetMap via Overpass (the open dataset whose street/place names
mirror what Google Maps shows; every name we spot-checked tonight against
Google-backed geocoders matched). Raw pulls archived locally by the agent;
the clipped record lives in this repo.

## Files
- `roads_drivable.geojson` — every drivable road segment inside the border,
  with street name where one exists (65,736 segments).
- `roads_all.geojson` — all road/path segments inside (90,950), incl. paths.
- `features.geojson` — all categorized features inside (29,000+): water,
  parks, golf, schools, churches, gas stations, businesses, restaurants,
  apartments, plazas, airport, transit, cemeteries, civic.
- `street_names.json` — every distinct street name found: **6,600 names**,
  with segment counts.
- `railroads.geojson` — every rail segment inside (1,257): Norfolk Southern,
  MARTA rail, CSX, Fulton County Railway.
- `bridges.geojson` — every bridge/overpass segment inside (747), from the
  road data's bridge tags (Joshua's terms: bridge = over water, overpass =
  over another road).
- `resource-map-1-roads-water.html` — VIEWABLE map 1: roads + street-name
  labels (zoom 15+), lakes/ponds/rivers/streams, parks, golf courses,
  railroads, bridges & overpasses (orange highlight layer).
- `resource-map-2-places.html` — VIEWABLE map 2: businesses, gas stations,
  schools, churches, restaurants, apartments, plazas, and every other named
  place as toggleable layers (labels at zoom 16+).

## Counts inside the border (named features)
- Gas stations 171 (151 named) · Schools 194 (188 named: 25 high, 17 middle,
  63 elementary, 83 other/academy by name) · Churches 883 (329 named)
- Restaurants & fast food 959 (945 named) · Businesses/shops/offices 972 (874 named)
- Apartments 890 (157 named complexes) · Plazas/commercial 2,240 (278 named)
- Parks 252 (190 named) · Golf courses 8 (6 named)
- Water bodies 505 (66 named) · Rivers/streams 1,217 segments (327 named)
- Fire/police 73 · Medical 73 · Post offices 40 · Libraries 28 · Hotels 35
- Transit stations 30 · Cemeteries 105 · Airport elements 2,165 (ATL + Brown Field)

## Street-name audit
48,693 drivable segments have no name in the data. Honest breakdown:
45,189 are `service` ways (driveways, parking aisles — Google doesn't name
these either) and ~2,900 are highway ramps/links (also unnamed on Google).
The real gaps: **1,970 residential segments and 138 unclassified** with no
recorded name — flagged here for later fixing, NOT deleted (standing rule).

## Joshua's named waters (PARAMETERS §5) — cross-check
Found in data: Chattahoochee River, Flint River, Utoy Creek, South Utoy
Creek, Nickajack Creek, Tatum Lake, Mount Gilead Lake.
**Not found under those names — KEPT and flagged (Joshua's ground truth
outranks the data): Boulder Creek, Arnolds Lake, Cobblestone Creek.**
They stay on the list for placement from Joshua's direction.

## Border rendering rule (Joshua, 2026-10-14)
The border is a DATA boundary only. The first build rendered a red line
around the map in-game; Joshua ordered it removed. Resource maps may show
the outline for reference; the game must never render it.

## Public transit (official GTFS, clipped to the border)
- MARTA: 54 routes touch the map (all 4 rail lines, streetcar, Rapid A,
  plus bus), 2,857 stops inside, 23 stations. Southeast corner (Clayton /
  Riverdale) is MARTA: routes 191 Riverdale, 196 Upper Riverdale,
  193 Morrow/Jonesboro, 178, 180, 189, 192, 194, 195, 197, 198 and more.
- CobbLinc (Cobb County's own feed): 4 routes reach inside - 10, 25, 30,
  R10 Rapid - 67 stops, covering the Mableton/Austell corner.
- Files: `transit_routes.geojson`, `transit_stops.geojson`,
  `resource-map-3-transit.html` (Map 3, with legend).

## Terrain (open DEM, AWS terrain tiles / SRTM-class data)
- Ground inside the border: 457 ft (river bottoms) to 1,149 ft (west
  ridges); mean ~919 ft. Bands + colors in `terrain_bands.json`;
  rendered tint+hillshade in `terrain_tint.png`.
- `resource-terrain-1-google-style.html` - Google-Maps-style terrain WITH KEY.
- `resource-terrain-2-opentopo.html` - OpenTopoMap rendering WITH KEY
  (contours in meters). Two renderings of the same ground, for cross-checks.

## Satellite
- `resource-map-4-satellite.html` - Map 4: full-resolution aerial imagery
  streamed tile-by-tile (Esri World Imagery, z18/19 = individual houses
  visible). Imagery is streamed, never baked/downscaled, so detail stays
  intact exactly as Joshua required. Border + anchor pins + major-roads
  overlay included (border is reference-only, per the red-line rule).

## Airports
- Airport features are on Map 2 (Places) as their own layer (50 named
  features; 2,165 airport elements incl. runways/taxiways in
  features.geojson): Hartsfield-Jackson ATL and Fulton County
  Airport-Brown Field, per Joshua 2026-10-14.
