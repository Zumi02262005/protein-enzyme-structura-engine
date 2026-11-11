# Disclaimer

This web application is vibe-coded and is built solely for the purpose of testing the capabilities
of current AI models.

# Structura

Search the RCSB Protein Data Bank, open any structure in 3D, and compare two structures by
laying one over the other. Runs entirely in the browser on `localhost`; there is no backend.

## Run it from the VS Code terminal

You need [Node.js](https://nodejs.org) 20 or newer (`node -v` to check) and an internet
connection, because the app reads live data from RCSB.

1. Open the `structura` folder in VS Code (**File → Open Folder…**).
2. Open the terminal (**Terminal → New Terminal**, or `` Ctrl+` ``).
3. Install the dependencies (first time only):

   ```bash
   npm install
   ```

4. Start the app:

   ```bash
   npm run dev
   ```

   Your browser opens at <http://localhost:5173>. If it does not, open that address yourself.
   Leave the terminal running while you use the app, and press `Ctrl+C` in it to stop.

Other commands:

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run build`     | Builds an optimised copy into `dist/`                           |
| `npm run preview`   | Serves that build at <http://localhost:4173>                    |
| `npm run typecheck` | Checks the TypeScript types without building                    |

If port 5173 is busy, Vite picks the next free port and prints it in the terminal.

## What it does

- **Search** by protein name, organism, ligand or PDB ID. Filter by experimental method and
  resolution, sort by best match, newest or sharpest. A typed PDB ID (for example `4HHB`) is
  shown first as an exact match.
- **View** a structure in 3D: cartoon, tube, ball-and-stick or space-filling; colour by chain,
  helix/strand, position along the chain, or B-factor; show or hide chains, ligands and water;
  hover or click residues, linked to a sequence strip; save the view as a PNG.
- **Compare** two structures. Structura picks the best-matching pair of chains (or the pair you
  choose), aligns their sequences, superposes the matched backbone atoms, and reports RMSD,
  sequence identity, coverage and a TM-score, with a per-residue distance plot and the alignment.

Addresses are shareable: `#/view/4HHB`, `#/compare/4HHB.A/1MBN.A`, `#/?q=kinase&method=em`.

## Tech stack, and why

| Piece         | Choice                                   | Reason                                                                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Build tool    | Vite                                     | One command to run on localhost, instant reloads while editing                           |
| UI            | React 19 + TypeScript                    | Component model fits the three pages; types catch mistakes in the structure code         |
| Data          | RCSB APIs called straight from the browser | Search, metadata and files all allow cross-origin requests, so no server or key is needed |
| 3D            | Custom WebGL2 renderer (`src/viewer`)    | No heavy viewer dependency, and full control over the look so it matches the interface   |
| Analysis      | Own TypeScript (`src/core`)              | mmCIF parsing, alignment and superposition are small enough to own and test              |
| Styling       | Plain CSS with design tokens             | The glass material is a handful of rules; no CSS framework needed                        |

The only runtime dependencies are `react` and `react-dom`.

RCSB endpoints used (see `src/api/rcsb.ts`):

- `search.rcsb.org/rcsbsearch/v2/query`: text and attribute search, returns PDB IDs
- `data.rcsb.org/graphql`: titles, methods, resolution, molecules, ligands, citation
- `files.rcsb.org/download/<ID>.cif`: coordinates in mmCIF format
- `cdn.rcsb.org/images/structures/<id>_assembly-1.jpeg`: preview images on the cards

## Project structure

```
structura/
├── index.html                  Page shell that loads src/main.tsx
├── package.json                Scripts and dependencies
├── tsconfig.json               TypeScript settings
├── vite.config.ts              Dev server settings (port 5173)
├── README.md
├── .gitignore
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx                Entry point: mounts <App /> and loads the styles
    ├── App.tsx                 Backdrop, navigation and page switching
    ├── router.ts               Hash-based routes (#/, #/view/…, #/compare/…)
    ├── hooks.ts                useAsync, media-query and element-size hooks
    ├── vite-env.d.ts
    ├── api/
    │   └── rcsb.ts             RCSB search, metadata and file client, plus formatting helpers
    ├── core/                   Structure maths, no UI or WebGL in here
    │   ├── types.ts            Structure / Chain / Residue data model
    │   ├── chem.ts             Element radii and colours, residue codes
    │   ├── mmcif.ts            mmCIF tokenizer and structure reader
    │   ├── secondary.ts        Helix/strand estimate for files without annotations
    │   ├── align.ts            Sequence alignment (Gotoh, BLOSUM62, free end gaps)
    │   ├── superpose.ts        Least-squares superposition (Horn) with outlier rejection
    │   └── compare.ts          Chain pairing, comparison metrics
    ├── viewer/                 3D engine
    │   ├── math.ts             Vectors, quaternions, matrices
    │   ├── palette.ts          Colours used in the 3D view
    │   ├── geometry.ts         Ribbon extrusion, sphere/cylinder templates, bond detection
    │   ├── scene.ts            Structure + display options → GPU buffers
    │   ├── shaders.ts          GLSL: lighting, contact shadows, outlines, fog
    │   └── renderer.ts         WebGL2 renderer, camera, mouse/touch input, picking
    ├── components/
    │   ├── NavBar.tsx          Top navigation and quick-open box
    │   ├── StructureCanvas.tsx React wrapper around the renderer
    │   ├── ResultCard.tsx      One search result
    │   ├── CompareTray.tsx     Dock holding the two structures picked for comparison
    │   ├── SequenceStrip.tsx   Scrolling sequence with helix/strand track
    │   ├── DeviationPlot.tsx   Per-residue distance chart
    │   ├── AlignmentView.tsx   Sequence alignment display
    │   ├── Segmented.tsx       Segmented control with sliding glass thumb
    │   ├── Switch.tsx          Toggle switch
    │   ├── States.tsx          Loading and error notes
    │   └── Icon.tsx            Inline SVG icons
    ├── pages/
    │   ├── SearchPage.tsx
    │   ├── ViewerPage.tsx
    │   └── ComparePage.tsx
    ├── state/
    │   └── compareTray.ts      The comparison picks, kept in localStorage
    └── styles/
        ├── base.css            Colour and type tokens, reset, ambient backdrop
        ├── ui.css              Glass material, navigation, buttons and controls
        └── pages.css           Search, viewer and compare layouts
```

## Changing the look

All colours are tokens at the top of `src/styles/base.css` (`--leaf`, `--fern`, `--forest`,
`--mist`, `--moss`, `--pine`, `--spruce`, `--lichen`, `--slate`). The glass material is the
`.glass` rule at the top of `src/styles/ui.css`. Colours inside the 3D view live in
`src/viewer/palette.ts`.

## How the comparison works

1. Each chain's modelled sequence is aligned with affine-gap dynamic programming (BLOSUM62 for
   proteins, match/mismatch scores for nucleic acids). End gaps are free, so a fragment can be
   matched against a full-length chain.
2. The Cα atoms (P or C4′ for nucleic acids) of aligned residues are superposed by least squares.
3. Pairs further apart than twice the RMSD are dropped and the fit is repeated, up to five times,
   so flexible loops do not drag the conserved core out of register. Both RMSDs are reported.
4. The TM-score is calculated on that superposition and normalised by the shorter chain.

## Things to know

- Residues are paired by **sequence**, not by shape. This works well for related proteins. For
  unrelated ones the app warns you, and a structure-based aligner would be the next thing to add.
- The 3D view shows the coordinates as deposited (the asymmetric unit). The preview images on the
  cards come from RCSB and show the biological assembly, so the two can differ.
- Only the first model of a multi-model file (for example an NMR ensemble) is drawn, and
  hydrogen atoms are skipped.
- Entries above 250,000 atoms ask before loading; the largest assemblies in the PDB will not fit
  in a browser tab.
- Needs a browser with WebGL2 (current Chrome, Edge, Firefox or Safari).

Data comes from the [RCSB Protein Data Bank](https://www.rcsb.org). If you publish work that uses
it, RCSB asks to be cited: <https://www.rcsb.org/pages/policies>.
