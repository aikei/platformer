// Checks that Level.serialize() → JSON → Level.deserialize() yields an identical
// level (tiles, solidity, biome, spawns). Run: npx tsx scripts/level-roundtrip.ts
import { Level } from '../src/level';

let failed = false;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${label}`);
  if (!cond) failed = true;
};

for (let trial = 0; trial < 20; trial++) {
  const a = new Level();
  const b = Level.deserialize(JSON.parse(JSON.stringify(a.serialize())));

  if (trial === 0) {
    check(b.biome === a.biome, `biome matches (${a.biome})`);
    check(b.width === a.width, `width matches (${a.width})`);
    check(
      JSON.stringify(b.spawns) === JSON.stringify(a.spawns),
      `spawns match (${a.spawns.length} total)`,
    );
  }

  let tilesEqual = true;
  let solidEqual = true;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (a.tileAt(x, y) !== b.tileAt(x, y)) tilesEqual = false;
      if (a.isSolid(x, y) !== b.isSolid(x, y)) solidEqual = false;
    }
  }
  if (!tilesEqual || !solidEqual) {
    check(tilesEqual, `[trial ${trial}] all tiles match`);
    check(solidEqual, `[trial ${trial}] solidity matches`);
  }
}
check(true, 'tiles and solidity matched across all 20 runs');

console.log(failed ? '\nLEVEL ROUNDTRIP FAILED' : '\nLEVEL ROUNDTRIP PASSED');
process.exit(failed ? 1 : 0);
