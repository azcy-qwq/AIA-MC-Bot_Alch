import { PveCombatScript } from "./pve-combat.js";
import { MlgWaterScript } from "./mlg-water.js";
import { FishboneMiningScript, VeinMiningScript } from "./mining.js";
import { NavigationSkill } from "./navigation.js";
import { RouteNavigationSkill } from "./route-navigation.js";
import { TerrainFlattenSkill } from "./terrain-flatten.js";
import { AutonomousWorkScript } from "./autonomous-work.js";

export function createSkills({ api, worldModel, executor, routeMemory, logger = console } = {}) {
  return {
    pve: new PveCombatScript({ api, worldModel, executor, logger }),
    mlgWater: new MlgWaterScript({ api, worldModel, executor, logger }),
    fishboneMining: new FishboneMiningScript({ api, executor }),
    veinMining: new VeinMiningScript({ api, executor }),
    navigation: new NavigationSkill({ api, worldModel, logger }),
    routes: new RouteNavigationSkill({ api, worldModel, routeMemory }),
    terrain: new TerrainFlattenSkill({ api, worldModel, logger }),
    work: new AutonomousWorkScript({ api, worldModel })
  };
}

export { PveCombatScript, MlgWaterScript, FishboneMiningScript, VeinMiningScript, NavigationSkill, RouteNavigationSkill, TerrainFlattenSkill };
