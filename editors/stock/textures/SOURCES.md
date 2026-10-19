# Textures — sources

Real surface textures for the game's buildings, roofs, ground and fences,
downloaded 2026-10-19 — Joshua's order of Oct 11–12 ("grab some free assets
from the internet... brick, wood siding, vinyl siding, planks, brick") carried
out for textures at last. (The earlier free-assets run brought back the Kenney
3D model kits on the props shelf; the textures were never fetched until now.)

Every file is a single diffuse / colour map, 1024 x 1024 JPG, seamlessly
tileable, **CC0 / public domain** — no attribution required, free to
redistribute in this repo. One texture per material named in the Building
Editor vocabularies (editors/stock/vocabularies/). These are resources only:
no game code uses them yet — wiring them into the renderer is a later step.

| File | Material | Source | Asset | Licence | Size |
|---|---|---|---|---|---|
| asphalt.jpg | Asphalt | Poly Haven | [Asphalt 01](https://polyhaven.com/a/asphalt_01) | CC0 | 739,513 bytes |
| brick.jpg | Brick | Poly Haven | [Red Brick](https://polyhaven.com/a/red_brick) | CC0 | 766,044 bytes |
| carpet.jpg | Carpet | ambientCG | [Carpet 001 (Carpet001)](https://ambientcg.com/a/Carpet001) | CC0 | 1,501,861 bytes |
| concrete-paving.jpg | Concrete Paving | Poly Haven | [Concrete Pavement](https://polyhaven.com/a/concrete_pavement) | CC0 | 926,197 bytes |
| concrete.jpg | Concrete | Poly Haven | [Concrete](https://polyhaven.com/a/concrete) | CC0 | 543,902 bytes |
| dirt.jpg | Dirt | Poly Haven | [Dirt](https://polyhaven.com/a/dirt) | CC0 | 730,425 bytes |
| fence-chainlink.jpg | Fence — Chain Link | ambientCG | [Fence 003 (Fence003)](https://ambientcg.com/a/Fence003) | CC0 | 1,159,871 bytes |
| fence-wood.jpg | Fence — Wood | Poly Haven | [Wood Plank Wall](https://polyhaven.com/a/wood_plank_wall) | CC0 | 498,698 bytes |
| flat-roof.jpg | Flat Roof | ambientCG | [Asphalt 031 (Asphalt031, asphalt roofing felt)](https://ambientcg.com/a/Asphalt031) | CC0 | 855,584 bytes |
| floor-tile.jpg | Tile Floor | Poly Haven | [Floor Tiles 02](https://polyhaven.com/a/floor_tiles_02) | CC0 | 354,550 bytes |
| grass.jpg | Grass | Poly Haven | [Grass Ground](https://polyhaven.com/a/grass_ground) | CC0 | 876,584 bytes |
| gravel.jpg | Gravel | Poly Haven | [Gravel](https://polyhaven.com/a/gravel) | CC0 | 925,640 bytes |
| hardwood.jpg | Hardwood Floor | Poly Haven | [Wood Floor](https://polyhaven.com/a/wood_floor) | CC0 | 734,493 bytes |
| laminate.jpg | Laminate Floor | Poly Haven | [Laminate Floor](https://polyhaven.com/a/laminate_floor) | CC0 | 525,944 bytes |
| metal-roof.jpg | Metal Roof | Poly Haven | [Box Profile Metal Sheet](https://polyhaven.com/a/box_profile_metal_sheet) | CC0 | 346,711 bytes |
| planks.jpg | Planks | Poly Haven | [Wood Planks](https://polyhaven.com/a/wood_planks) | CC0 | 609,525 bytes |
| shingle.jpg | Shingle | Poly Haven | [Grey Roof 01 (grey shingle-style roof tiles)](https://polyhaven.com/a/grey_roof_01) | CC0 | 419,760 bytes |
| stucco.jpg | Stucco | Poly Haven | [White Stucco](https://polyhaven.com/a/white_stucco) | CC0 | 557,550 bytes |
| thatch.jpg | Thatch | Poly Haven | [Thatch Roof Angled](https://polyhaven.com/a/thatch_roof_angled) | CC0 | 860,319 bytes |
| tile-roof.jpg | Tile Roof | Poly Haven | [Clay Roof Tiles](https://polyhaven.com/a/clay_roof_tiles) | CC0 | 878,367 bytes |
| wood-siding.jpg | Wood Siding | ambientCG | [Wood Siding 005 (WoodSiding005)](https://ambientcg.com/a/WoodSiding005) | CC0 | 869,023 bytes |

Total: 21 files, 15,680,561 bytes.

## Coverage notes

- **Vinyl Siding is the one gap.** No CC0 library carries a vinyl siding texture
  (checked Poly Haven, ambientCG, cgbookcase, ShareTextures, OpenGameArt).
  3dtextures.me (CC0) has exactly the right one — "Wall Siding 001", a smooth
  white lap siding — but that site downloads only through Google Drive, and
  Drive downloads are blocked from the build machine (HTTP 500). It can be
  fetched later from any ordinary connection and dropped in as vinyl-siding.jpg.
- Fence styles Wood / Metal / Chain Link / Brick: wood = fence-wood.jpg,
  chain link (metal) = fence-chainlink.jpg, brick fence uses brick.jpg.
  The chain-link colour map shows the mesh over a neutral grey backing, as
  scanned; the source asset also ships an opacity map for see-through use.
- Driveway "Concrete" and "Paved": concrete-paving.jpg and asphalt.jpg.
- Roof "Shingle": grey shingle-style roof tiles (Poly Haven "Grey Roof 01") —
  the closest CC0 match to grey asphalt shingles obtainable; a true asphalt-
  shingle scan exists at 3dtextures.me under the same Drive block as vinyl.

