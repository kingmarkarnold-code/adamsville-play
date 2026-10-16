# Adamsville Map Viewer — Web

One responsive web viewer for the Surviving Adamsville reference maps.
Works on mobile and desktop (the layout adapts; the layers panel collapses
behind a button on small screens).

- Engine: MapLibre GL (pan, zoom, rotate, pitch).
- Top tabs toggle data layers (tap again to hide): Roads, Buildings,
  Places, Transit, Water, Parks, Rail & Bridges.
- Right panel: base map — Default / Terrain / Satellite (labels stay
  available on Terrain and Satellite, like Google Maps) — plus overlays
  (street & place names, border reference, transit stops).
- "3D view" leaves this viewer for the separate Three.js 3D map.
- ALL data loads live from the map-data repo's Pages site. This repo holds
  only the viewer; the data's single source of truth stays in map-data.
