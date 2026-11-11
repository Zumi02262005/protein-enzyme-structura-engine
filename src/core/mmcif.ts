/**
 * mmCIF reader.
 *
 * `parseCif` is a small streaming tokenizer for the CIF syntax (loops, key/value pairs, quoted
 * strings and multi-line text blocks). `parseStructure` uses it to pull the atoms and the
 * helix/strand annotations out of a file downloaded from files.rcsb.org.
 */
import { EL_D, EL_H, WATER_NAMES, aminoCode, elementIndex, nucleotideCode } from './chem';
import { estimateSecondaryStructure } from './secondary';
import type { Chain, Residue, Structure } from './types';
import { SS_HELIX, SS_STRAND } from './types';

export interface CategorySink {
  /** Called once with the column names (without the category prefix). */
  columns(names: string[]): void;
  /** Called for every row. The array is reused between calls: copy what you keep. */
  row(values: string[]): void;
}

/** Tokenize CIF text and feed the categories the caller asks for. */
export function parseCif(text: string, want: (category: string) => CategorySink | null): void {
  const n = text.length;
  let i = 0;
  let quoted = false;

  const next = (): string | null => {
    quoted = false;
    for (;;) {
      // skip whitespace
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 10 || c === 13 || c === 9) i++;
        else break;
      }
      if (i >= n) return null;
      const c = text.charCodeAt(i);
      if (c === 35 /* # */) {
        // comment: skip to end of line
        while (i < n && text.charCodeAt(i) !== 10) i++;
        continue;
      }
      if (c === 59 /* ; */ && (i === 0 || text.charCodeAt(i - 1) === 10)) {
        // multi-line text block, ends with a line starting with ';'
        const start = i + 1;
        let end = text.indexOf('\n;', start);
        if (end === -1) end = n;
        i = Math.min(n, end + 2);
        quoted = true;
        return text.slice(start, end).replace(/\r/g, '').trim();
      }
      if (c === 39 /* ' */ || c === 34 /* " */) {
        // quoted string: closes at the same quote followed by whitespace or end of file
        const start = i + 1;
        let j = start;
        for (;;) {
          while (j < n && text.charCodeAt(j) !== c && text.charCodeAt(j) !== 10) j++;
          if (j >= n || text.charCodeAt(j) === 10) break;
          const after = j + 1 < n ? text.charCodeAt(j + 1) : 32;
          if (after === 32 || after === 10 || after === 13 || after === 9) break;
          j++;
        }
        i = Math.min(n, j + 1);
        quoted = true;
        return text.slice(start, j);
      }
      const start = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 32 || d === 10 || d === 13 || d === 9) break;
        i++;
      }
      return text.slice(start, i);
    }
  };

  const isTag = (t: string) => t.charCodeAt(0) === 95; /* _ */
  const isKeyword = (t: string) => t === 'loop_' || t.startsWith('data_') || t.startsWith('save_') || t === 'stop_' || t === 'global_';
  const split = (tag: string): [string, string] => {
    const dot = tag.indexOf('.');
    return dot === -1 ? [tag, ''] : [tag.slice(0, dot), tag.slice(dot + 1)];
  };

  // key/value pairs belonging to one category are gathered and delivered as a single row
  let kvCategory = '';
  let kvNames: string[] = [];
  let kvValues: string[] = [];
  const flush = () => {
    if (kvCategory) {
      const sink = want(kvCategory);
      if (sink) {
        sink.columns(kvNames);
        sink.row(kvValues);
      }
    }
    kvCategory = '';
    kvNames = [];
    kvValues = [];
  };

  let tok = next();
  while (tok !== null) {
    if (!quoted && tok === 'loop_') {
      flush();
      const tags: string[] = [];
      tok = next();
      while (tok !== null && !quoted && isTag(tok)) {
        tags.push(tok);
        tok = next();
      }
      if (tags.length === 0) continue;
      const sink = want(split(tags[0])[0]);
      const ncol = tags.length;
      if (sink) sink.columns(tags.map((t) => split(t)[1]));
      const row: string[] = new Array<string>(ncol).fill('');
      let c = 0;
      while (tok !== null && (quoted || !(isTag(tok) || isKeyword(tok)))) {
        if (sink) row[c] = tok;
        c++;
        if (c === ncol) {
          if (sink) sink.row(row);
          c = 0;
        }
        tok = next();
      }
      continue;
    }
    if (!quoted && isTag(tok)) {
      const [category, field] = split(tok);
      const value = next();
      if (category !== kvCategory) {
        flush();
        kvCategory = category;
      }
      kvNames.push(field);
      kvValues.push(value ?? '');
      tok = next();
      continue;
    }
    flush();
    tok = next();
  }
  flush();
}

/* -------------------------------------------------------------------------------------------- */

class Grow {
  f32: Float32Array;
  length = 0;
  constructor(capacity: number) {
    this.f32 = new Float32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.f32.length) {
      const bigger = new Float32Array(this.f32.length * 2);
      bigger.set(this.f32);
      this.f32 = bigger;
    }
    this.f32[this.length++] = v;
  }
  done(): Float32Array {
    return this.f32.slice(0, this.length);
  }
}

const isBlank = (v: string) => v === '.' || v === '?' || v === '';

interface AtomSink extends CategorySink {
  /** Close the last residue and chain once the loop has been read. */
  finish(): void;
}

interface Range {
  asym: string;
  beg: number;
  end: number;
  ss: 1 | 2;
}

/** Read an mmCIF file into a `Structure`. Loads the first model and skips hydrogens. */
export function parseStructure(text: string, id: string): Structure {
  const xyz = new Grow(4096 * 3);
  const bfac = new Grow(4096);
  const elements: number[] = [];
  const atomName: string[] = [];
  const atomResidueList: number[] = [];
  const residues: Residue[] = [];
  const chains: Chain[] = [];
  const ranges: Range[] = [];
  let modelCount = 0;
  let hydrogensSkipped = 0;

  const atomSink = (): AtomSink => {
    let cSym = -1, cAtom = -1, cAlt = -1, cComp = -1, cAsym = -1, cEntity = -1, cSeq = -1, cIns = -1;
    let cX = -1, cY = -1, cZ = -1, cB = -1, cAuthSeq = -1, cAuthAsym = -1, cModel = -1, cAuthComp = -1;
    let firstModel: string | null = null;
    let lastModel: string | null = null;
    let skipModel = false;
    // identity of the residue currently being filled
    let rAsym = '', rSeq = '', rAuthSeq = '', rIns = '', rComp = '';
    let rAlt = '';
    let skipResidue = false;
    let siteOpen = false;
    let current: Residue | null = null;
    let chain: Chain | null = null;
    // per-residue backbone bookkeeping
    let hasN = false, hasC = false, hasC1p = false;
    let iCA = -1, iO = -1, iP = -1, iC4p = -1;

    const closeResidue = () => {
      if (!current) return;
      const r = current;
      r.atomEnd = atomName.length;
      const count = r.atomEnd - r.atomStart;
      if (count === 0) {
        residues.pop();
        current = null;
        return;
      }
      if (WATER_NAMES.has(r.name)) r.kind = 'water';
      else if (iCA >= 0 && hasN && hasC) {
        r.kind = 'protein';
        r.trace = iCA;
        r.oxygen = iO;
        r.code = aminoCode(r.name);
      } else if (iC4p >= 0 && hasC1p) {
        r.kind = 'nucleic';
        r.trace = iP >= 0 ? iP : iC4p;
        r.code = nucleotideCode(r.name);
      } else if (iCA >= 0 && r.labelSeq > 0 && aminoCode(r.name) !== 'X') {
        // Cα-only models (some low-resolution entries) still carry a usable trace
        r.kind = 'protein';
        r.trace = iCA;
        r.code = aminoCode(r.name);
      } else if (iP >= 0 && r.labelSeq > 0 && nucleotideCode(r.name) !== 'N') {
        // phosphate-only nucleic acid models
        r.kind = 'nucleic';
        r.trace = iP;
        r.code = nucleotideCode(r.name);
      } else r.kind = count === 1 ? 'ion' : 'ligand';
      current = null;
    };

    return {
      columns(names) {
        const col = (name: string) => names.indexOf(name);
        cSym = col('type_symbol');
        cAtom = col('label_atom_id');
        cAlt = col('label_alt_id');
        cComp = col('label_comp_id');
        cAsym = col('label_asym_id');
        cEntity = col('label_entity_id');
        cSeq = col('label_seq_id');
        cIns = col('pdbx_PDB_ins_code');
        cX = col('Cartn_x');
        cY = col('Cartn_y');
        cZ = col('Cartn_z');
        cB = col('B_iso_or_equiv');
        cAuthSeq = col('auth_seq_id');
        cAuthAsym = col('auth_asym_id');
        cAuthComp = col('auth_comp_id');
        cModel = col('pdbx_PDB_model_num');
        if (cX < 0 || cY < 0 || cZ < 0) throw new Error('This file has no atom coordinates.');
        if (cAtom < 0) cAtom = col('auth_atom_id');
        if (cComp < 0) cComp = cAuthComp;
        if (cAsym < 0) cAsym = cAuthAsym;
        if (cAtom < 0 || cComp < 0 || cAsym < 0) throw new Error('This file is missing required atom columns.');
      },
      row(v) {
        if (cModel >= 0) {
          const model = v[cModel];
          if (model !== lastModel) {
            lastModel = model;
            modelCount++;
            if (firstModel === null) firstModel = model;
            skipModel = model !== firstModel;
          }
          if (skipModel) return;
        } else if (modelCount === 0) modelCount = 1;

        const asym = v[cAsym];
        const seq = cSeq >= 0 ? v[cSeq] : '.';
        const authSeq = cAuthSeq >= 0 ? v[cAuthSeq] : seq;
        const ins = cIns >= 0 && !isBlank(v[cIns]) ? v[cIns] : '';
        const comp = v[cComp];

        if (asym !== rAsym || seq !== rSeq || authSeq !== rAuthSeq || ins !== rIns || comp !== rComp) {
          // Two different residues modelled at the same sequence position: keep the first.
          const sameSite = siteOpen && asym === rAsym && seq === rSeq && !isBlank(seq) && ins === rIns && comp !== rComp;
          closeResidue();
          if (!chain || chain.labelId !== asym) {
            if (chain) chain.residueEnd = residues.length;
            chain = {
              index: chains.length,
              id: cAuthAsym >= 0 && !isBlank(v[cAuthAsym]) ? v[cAuthAsym] : asym,
              labelId: asym,
              entityId: cEntity >= 0 ? v[cEntity] : '',
              kind: 'other',
              residueStart: residues.length,
              residueEnd: residues.length,
              sequence: '',
              sequenceResidues: [],
            };
            chains.push(chain);
          }
          rAsym = asym;
          rSeq = seq;
          rAuthSeq = authSeq;
          rIns = ins;
          rComp = comp;
          siteOpen = true;
          skipResidue = sameSite;
          rAlt = '';
          hasN = hasC = hasC1p = false;
          iCA = iO = iP = iC4p = -1;
          if (!skipResidue) {
            const labelSeq = isBlank(seq) ? -1 : parseInt(seq, 10);
            const authNum = parseInt(authSeq, 10);
            current = {
              index: residues.length,
              chain: chain.index,
              name: comp,
              code: '',
              seq: Number.isFinite(authNum) ? authNum : labelSeq,
              labelSeq: Number.isFinite(labelSeq) ? labelSeq : -1,
              insCode: ins,
              atomStart: atomName.length,
              atomEnd: atomName.length,
              kind: 'ligand',
              ss: 0,
              trace: -1,
              oxygen: -1,
            };
            residues.push(current);
          }
        }
        if (skipResidue || !current) return;

        // alternate locations: keep only the first conformer seen in this residue
        if (cAlt >= 0) {
          const alt = v[cAlt];
          if (!isBlank(alt)) {
            if (rAlt === '') rAlt = alt;
            else if (alt !== rAlt) return;
          }
        }

        const name = v[cAtom];
        const symbol = cSym >= 0 && !isBlank(v[cSym]) ? v[cSym] : name.replace(/[^A-Za-z]/g, '').slice(0, 1);
        const e = elementIndex(symbol);
        if (e === EL_H || e === EL_D) {
          hydrogensSkipped++;
          return;
        }
        const x = parseFloat(v[cX]);
        const y = parseFloat(v[cY]);
        const z = parseFloat(v[cZ]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

        const index = atomName.length;
        xyz.push(x);
        xyz.push(y);
        xyz.push(z);
        const b = cB >= 0 ? parseFloat(v[cB]) : 0;
        bfac.push(Number.isFinite(b) ? b : 0);
        elements.push(e);
        atomName.push(name);
        atomResidueList.push(current.index);

        switch (name) {
          case 'N': hasN = true; break;
          case 'C': hasC = true; break;
          case 'CA': if (symbol.toUpperCase() === 'C' && iCA < 0) iCA = index; break;
          case 'O': if (iO < 0) iO = index; break;
          case 'P': if (iP < 0) iP = index; break;
          case "C4'": case 'C4*': if (iC4p < 0) iC4p = index; break;
          case "C1'": case 'C1*': hasC1p = true; break;
        }
      },
      finish() {
        closeResidue();
        if (chain) chain.residueEnd = residues.length;
      },
    };
  };

  const rangeSink = (ss: 1 | 2, typeColumn: string | null): CategorySink => {
    let cType = -1, cAsym = -1, cBeg = -1, cEndAsym = -1, cEnd = -1;
    return {
      columns(names) {
        cType = typeColumn ? names.indexOf(typeColumn) : -1;
        cAsym = names.indexOf('beg_label_asym_id');
        cBeg = names.indexOf('beg_label_seq_id');
        cEndAsym = names.indexOf('end_label_asym_id');
        cEnd = names.indexOf('end_label_seq_id');
      },
      row(v) {
        if (cAsym < 0 || cBeg < 0 || cEnd < 0) return;
        if (typeColumn && cType >= 0 && !v[cType].toUpperCase().startsWith('HELX')) return;
        if (cEndAsym >= 0 && v[cEndAsym] !== v[cAsym]) return;
        const beg = parseInt(v[cBeg], 10);
        const end = parseInt(v[cEnd], 10);
        if (!Number.isFinite(beg) || !Number.isFinite(end)) return;
        ranges.push({ asym: v[cAsym], beg: Math.min(beg, end), end: Math.max(beg, end), ss });
      },
    };
  };

  let atoms: AtomSink | null = null;
  let sawConf = false;
  let sawSheet = false;
  parseCif(text, (category) => {
    switch (category) {
      case '_atom_site':
        if (atoms) return null;
        atoms = atomSink();
        return atoms;
      case '_struct_conf':
        sawConf = true;
        return rangeSink(SS_HELIX as 1, 'conf_type_id');
      case '_struct_sheet_range':
        sawSheet = true;
        return rangeSink(SS_STRAND as 2, null);
      default:
        return null;
    }
  });
  if (!atoms) throw new Error('This file has no atom records.');
  (atoms as AtomSink).finish();

  const atomCount = atomName.length;
  if (atomCount === 0) throw new Error('This file has no atoms that can be displayed.');

  // drop chains that ended up empty and renumber
  const kept = chains.filter((c) => c.residueEnd > c.residueStart);
  kept.forEach((c, index) => {
    c.index = index;
    for (let r = c.residueStart; r < c.residueEnd; r++) residues[r].chain = index;
  });

  for (const c of kept) {
    let protein = 0;
    let nucleic = 0;
    for (let r = c.residueStart; r < c.residueEnd; r++) {
      if (residues[r].kind === 'protein') protein++;
      else if (residues[r].kind === 'nucleic') nucleic++;
    }
    if (protein >= 2 && protein >= nucleic) c.kind = 'protein';
    else if (nucleic >= 2) c.kind = 'nucleic';
    else c.kind = 'other';

    const letters: string[] = [];
    for (let r = c.residueStart; r < c.residueEnd; r++) {
      const res = residues[r];
      if (c.kind === 'other') {
        // a lone amino acid or nucleotide is a ligand, not a polymer
        if (res.kind === 'protein' || res.kind === 'nucleic') {
          res.kind = 'ligand';
          res.trace = -1;
          res.oxygen = -1;
          res.code = '';
        }
      } else if (res.kind === c.kind) {
        letters.push(res.code);
        c.sequenceResidues.push(r);
      } else if (res.kind === 'protein' || res.kind === 'nucleic') {
        // the odd one out inside a polymer of the other type is drawn as a ligand
        res.kind = 'ligand';
        res.trace = -1;
        res.oxygen = -1;
        res.code = '';
      }
    }
    c.sequence = letters.join('');
  }

  const structure: Structure = {
    id,
    atomCount,
    xyz: xyz.done(),
    bfactor: bfac.done(),
    element: Uint8Array.from(elements),
    atomName,
    atomResidue: Int32Array.from(atomResidueList),
    residues,
    chains: kept,
    modelCount: Math.max(1, modelCount),
    ssSource: 'none',
    hydrogensSkipped,
  };

  if (ranges.length > 0) {
    const byAsym = new Map<string, Range[]>();
    for (const range of ranges) {
      const list = byAsym.get(range.asym);
      if (list) list.push(range);
      else byAsym.set(range.asym, [range]);
    }
    for (const c of kept) {
      const list = byAsym.get(c.labelId);
      if (!list || c.kind !== 'protein') continue;
      for (let r = c.residueStart; r < c.residueEnd; r++) {
        const res = residues[r];
        if (res.kind !== 'protein' || res.labelSeq < 0) continue;
        for (const range of list) {
          if (res.labelSeq >= range.beg && res.labelSeq <= range.end) {
            // strands win over helices when annotations overlap
            if (range.ss === SS_STRAND || res.ss === 0) res.ss = range.ss;
          }
        }
      }
    }
    structure.ssSource = 'file';
  } else if (!sawConf && !sawSheet) {
    if (estimateSecondaryStructure(structure)) structure.ssSource = 'estimated';
  } else {
    structure.ssSource = 'file';
  }
  return structure;
}
