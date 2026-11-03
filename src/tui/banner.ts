// The banner art, after the Hatchet intro video: blocky pixel lettering and an ASCII hatchet.

// Pixel fonts, one string per pixel row; '#' is lit. FONT7 is 5×7, FONT5 is 3×5.
const FONT7: Record<string, string[]> = {
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
};

const FONT5: Record<string, string[]> = {
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  E: ['###', '#..', '##.', '#..', '###'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  ' ': ['..', '..', '..', '..', '..'],
};

/** Draws `text` in a pixel font, two pixel rows per terminal row, with half blocks. */
function pixels(text: string, font: Record<string, string[]>): string[] {
  const glyphs = [...text].map((c) => font[c]);
  const height = glyphs[0].length;
  const lit = (y: number) => glyphs.flatMap((g, i) => [...(g[y] ?? '.'.repeat(g[0].length))].map((c) => c === '#').concat(i < glyphs.length - 1 ? [false] : []));
  const out: string[] = [];
  for (let y = 0; y < height; y += 2) {
    const top = lit(y);
    const bottom = y + 1 < height ? lit(y + 1) : top.map(() => false);
    out.push(top.map((t, x) => (t && bottom[x] ? '█' : t ? '▀' : bottom[x] ? '▄' : ' ')).join(''));
  }
  return out;
}

export const HATCHET_BIG = pixels('HATCHET', FONT7);
export const HATCHET_SMALL = pixels('HATCHET', FONT5);
export const QUERY_RACE = pixels('QUERY RACE', FONT5);

/** The hatchet from the video's title card: a dotted wooden handle and a blade of %, stepping out from the handle. */
export const AXE = [
  ".-.       . :   ",
  "|:|     . :=%%%|",
  "|:|  . :=%%%%%%|",
  "|:| =%%%%%%%%%%|",
  "|:| =%%%%%%%%%%|",
  "|:|  . :=%%%%%%|",
  "|:|     . :=%%%|",
  "|:|       . :   ",
  "'-'             ",
];

/** The wide banner: the hatchet, then HATCHET over QUERY RACE and two status lines. */
export const BANNER_W = AXE[0].length + 2 + HATCHET_BIG[0].length;
export const BANNER_ROWS = AXE.length;
/** The narrow banner: a small HATCHET beside three status lines, then the status. */
export const BANNER_NARROW_ROWS = HATCHET_SMALL.length + 1;

/** The cat with a hatchet, from a 74×34 ASCII drawing, as braille: each cell holds 2×4 of the drawing's characters. */
export const CAT = [
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⠟⠓⢦⣤⣤⣤⣤⣤⣴⠚⠛⣧⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⣤⣶⣦⡄⠀⠀⠀⢀⡴⠋⠀⣀⣀⠀⠀⠀⢀⣀⣀⠀⠀⠙⢦⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⣀⣀⣤⣴⣾⣿⣿⣿⣿⣦⡘⠛⠛⢿⣛⠃⠁⠈⠶⠼⠦⠆⠁⠉⠘⠛⣛⡿⠻⠯⠍⠁⠀⠀⠀',
  '⠺⣿⣿⣿⣿⣿⣿⣿⣿⠿⠻⣿⣷⣄⢀⣴⢟⡉⠁⣀⣀⣤⣄⣀⡀⠀⠈⠉⠳⣆⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠈⠛⠿⣿⣿⡿⠋⠀⠀⠀⠈⠻⣿⣿⣧⡟⠀⣾⠁⠀⠀⠀⠈⢹⡆⠸⡆⠀⠘⣧⠀⠀⣠⡤⠤⣄',
  '⠀⠀⠀⠀⠀⠁⠀⠀⠀⠀⠀⠀⠀⠘⠻⣿⡇⠀⢻⣄⡀⠀⠀⢀⣸⠇⠀⠷⣶⡦⠟⢀⣠⠏⠀⣠⡟',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⣷⠀⠀⠈⢉⣙⣋⣉⠁⠀⠀⠀⣸⣛⣿⡭⠥⠖⠚⠉⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⣧⠀⠀⣸⠃⠀⢘⣇⠀⠀⢰⡏⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠛⠛⠋⠁⠀⠀⠘⠛⠚⠚⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀',
];
