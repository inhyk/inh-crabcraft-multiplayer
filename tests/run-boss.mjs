import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require=createRequire(import.meta.url);
const esbuild=require(require.resolve('esbuild',{paths:[require.resolve('wrangler')]}));
esbuild.buildSync({entryPoints:['src/game/shoreBoat.ts','src/game/boss.ts','src/game/enemies.ts','src/multiplayer/battle.ts','src/game/combat.ts','src/game/quests.ts','src/game/player.ts','src/game/bossLocale.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outdir:'tmp/test-modules',outbase:'src',entryNames:'[name]'});
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','tests/boats.test.mjs','tests/boss.test.mjs','tests/battle.test.mjs','tests/quests.test.mjs','tests/enemies.test.mjs','tests/player-cooldowns.test.mjs'],{stdio:'inherit'});
process.exit(result.status??1);
