#include "engine.hpp"
namespace mc {
static P direction(const J& p){auto d=p.value("direction",J("z"));if(d.is_array())return point(d);std::string s=d.is_string()?d.get<std::string>():"z";if(s=="x"||s=="east")return {1,0,0};if(s=="-x"||s=="west")return {-1,0,0};if(s=="-z"||s=="north")return {0,0,-1};if(s=="z"||s=="south")return {0,0,1};throw Failure("bad_args","方向须为 x/-x/z/-z 或水平单位向量");}
static std::string dropFor(std::string n){if(n=="stone")return "cobblestone";if(n=="deepslate")return "cobbled_deepslate";if(n.rfind("deepslate_",0)==0)n=n.substr(10);if(n=="iron_ore")return "raw_iron";if(n=="gold_ore")return "raw_gold";if(n=="copper_ore")return "raw_copper";if(n=="coal_ore")return "coal";if(n=="diamond_ore")return "diamond";if(n=="redstone_ore")return "redstone";if(n=="lapis_ore")return "lapis_lazuli";if(n=="emerald_ore")return "emerald";if(n=="quartz_ore")return "quartz";return n;}
static std::string entityItem(std::string n){if(n.rfind("minecraft:",0)==0)n=n.substr(10);auto x=n.rfind('x');if(x!=std::string::npos&&x+1<n.size()&&std::all_of(n.begin()+x+1,n.end(),[](unsigned char c){return std::isdigit(c);}))n=n.substr(0,x);return n;}
static J inventoryBrief(const J& inv){
  auto countItem=[&](const std::string& item){int n=0;std::set<int> slots;auto addItem=[&](const J& x){if(!x.is_object()||name(x)!=item)return;int slot=x.value("slot",-1);if(slot<0||slots.insert(slot).second)n+=x.value("count",1);};for(const auto& x:inv.value("items",J::array()))addItem(x);for(auto key:{"held","offhand"})if(inv.contains(key))addItem(inv[key]);if(inv.contains("armor")&&inv["armor"].is_object())for(const auto& x:inv["armor"])addItem(x);return n;};
  auto best=[&](std::initializer_list<const char*> items){static const std::map<std::string,int> rank={{"wooden",1},{"golden",1},{"stone",2},{"iron",3},{"diamond",4},{"netherite",5}};std::string chosen="none";int level=0;for(auto raw:items){std::string item(raw);if(countItem(item)<1)continue;auto split=item.find('_');std::string tier=split==std::string::npos?item:item.substr(0,split);int r=rank.count(tier)?rank.at(tier):0;if(r>level){level=r;chosen=tier;}}return J{{"tier",chosen},{"level",level}};};
  J logs=J::object();int plankItems=0,planks=0,sticks=countItem("stick");for(auto kind:{"oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak"}){int logN=countItem(std::string(kind)+"_log"),woodN=countItem(std::string(kind)+"_wood"),plankN=countItem(std::string(kind)+"_planks");logs[std::string(kind)+"_log"]=logN;logs[std::string(kind)+"_wood"]=woodN;plankItems+=plankN;planks+=plankN+4*(logN+woodN);}
  int coal=countItem("coal"),charcoal=countItem("charcoal"),ironIngot=countItem("iron_ingot"),iron=ironIngot+countItem("raw_iron")+countItem("iron_ore")+countItem("deepslate_iron_ore");int stone=countItem("cobblestone")+countItem("cobbled_deepslate")+countItem("stone")+countItem("deepslate");
  J equipped={{"mainHand",inv.value("held",J())},{"offHand",inv.value("offhand",J())},{"armor",inv.value("armor",J::object())}};
  J tools={{"pickaxe",best({"netherite_pickaxe","diamond_pickaxe","iron_pickaxe","stone_pickaxe","wooden_pickaxe","golden_pickaxe"})},{"axe",best({"netherite_axe","diamond_axe","iron_axe","stone_axe","wooden_axe","golden_axe"})},{"shovel",best({"netherite_shovel","diamond_shovel","iron_shovel","stone_shovel","wooden_shovel","golden_shovel"})},{"sword",best({"netherite_sword","diamond_sword","iron_sword","stone_sword","wooden_sword","golden_sword"})},{"hoe",best({"netherite_hoe","diamond_hoe","iron_hoe","stone_hoe","wooden_hoe","golden_hoe"})},{"helmet",best({"netherite_helmet","diamond_helmet","iron_helmet","chainmail_helmet","golden_helmet","turtle_helmet","leather_helmet"})},{"chestplate",best({"netherite_chestplate","diamond_chestplate","iron_chestplate","chainmail_chestplate","golden_chestplate","leather_chestplate"})},{"leggings",best({"netherite_leggings","diamond_leggings","iron_leggings","chainmail_leggings","golden_leggings","leather_leggings"})},{"boots",best({"netherite_boots","diamond_boots","iron_boots","chainmail_boots","golden_boots","leather_boots"})}};
  int diamondCredit=countItem("enchanting_table")>0?2:0;for(const auto& entry:std::map<std::string,int>{{"helmet",5},{"chestplate",8},{"leggings",7},{"boots",4},{"pickaxe",3},{"sword",2}})if(countItem("diamond_"+entry.first)>0||countItem("netherite_"+entry.first)>0)diamondCredit+=entry.second;
  J craftable={{"woodenPickaxeUpperBound",std::min(planks/3,sticks+planks/2)},{"stonePickaxeUpperBound",std::min(stone/3,sticks+planks/2)},{"ironPickaxeUpperBound",std::min(ironIngot/3,sticks+planks/2)},{"furnaceUpperBound",stone/8},{"torchUpperBound",coal+charcoal}};
  return {{"diamondBudget",{{"total",31},{"craftedCredit",diamondCredit},{"loose",countItem("diamond")},{"missing",std::max(0,31-diamondCredit-countItem("diamond"))}}},{"stone",{{"usableBlocks",stone},{"cobblestone",countItem("cobblestone")},{"cobbledDeepslate",countItem("cobbled_deepslate")}}},{"iron",{{"ingots",ironIngot},{"rawAndOre",iron-ironIngot},{"totalUnits",iron}}},{"wood",{{"logs",logs},{"planks",plankItems},{"sticks",sticks},{"plankEquivalentIncludingLogs",planks+sticks*2}}},{"coal",{{"coal",coal},{"charcoal",charcoal},{"fuelUnits",coal+charcoal}}},{"tools",tools},{"equipped",equipped},{"craftableUpperBounds",craftable},{"emptySlots",inv.value("empty_slots",-1)}};
}
static bool recoverable(const Failure& e){static const std::set<std::string> allowed={"path_not_found","navigation_failed","unreachable","unsafe_excavation","unsafe_navigation","falling_block_risk","protected_workarea","out_of_reach","out_of_range","no_progress"};return allowed.count(e.code);}
static const std::vector<std::string> RUBBLE={"cobblestone","cobbled_deepslate","stone","deepslate","andesite","granite","diorite","tuff","smooth_basalt","basalt","blackstone","calcite","dirt","gravel","sand","red_sand","leaf_litter","wildflowers"};
J Engine::maintainMiningTools(J inv){
  if(blocksDug-toolMaintenanceAt<32)return inv;toolMaintenanceAt=blocksDug;
  auto remaining=[&](const std::string& item,int max){int n=0;for(const auto& stack:inv.value("items",J::array()))if(name(stack)==item)n=std::max(n,max-stack.value("durability_used",0));return n;};
  if(count(inv,"netherite_pickaxe"))return inv;
  bool diamondLow=remaining("diamond_pickaxe",1561)<160&&count(inv,"diamond")>=3;
  if(count(inv,"diamond_pickaxe")&&!diamondLow)return inv;
  bool stoneLow=remaining("stone_pickaxe",131)<16;
  int ingots=count(inv,"iron_ingot"),raw=count(inv,"raw_iron");
  bool ironLow=count(inv,"iron_pickaxe")<=1&&remaining("iron_pickaxe",250)<32&&ingots+raw>=3;
  if(!diamondLow&&!stoneLow&&!ironLow)return inv;
  P work=point(status()["pos"]);
  try{
    if(diamondLow){progress("mining_tool_supply",{{"item","diamond_pickaxe"},{"count",1},{"returnTo",jp(work)}});craft("diamond_pickaxe",1);inv=inventory();}
    if(!diamondLow&&ironLow){
      if(ingots<3){
        if(!count(inv,"furnace")){try{facility("furnace",J::object());}catch(const Failure& e){if(e.code!="missing_facility")throw;craft("furnace",1);}}
        progress("mining_tool_supply",{{"item","iron_pickaxe"},{"step","smelt"},{"returnTo",jp(work)}});
        workshop({{"mode","smelt"},{"item","raw_iron"},{"count",3-ingots}});
      }
      craft("iron_pickaxe",1);inv=inventory();
    }
    if(!diamondLow&&stoneLow){progress("mining_tool_supply",{{"item","stone_pickaxe"},{"count",2},{"returnTo",jp(work)}});craft("stone_pickaxe",2);inv=inventory();}
    if(point(status()["pos"])!=work)navigate(work,false);
    progress("mining_tools_ready",{{"returnTo",jp(work)},{"stonePickaxes",count(inv,"stone_pickaxe")},{"ironPickaxes",count(inv,"iron_pickaxe")}});
  }catch(const Failure& e){
    if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled")throw;
    if(point(status()["pos"])!=work)navigate(work,false);
    progress("mining_tool_supply_warning",{{"code",e.code},{"message",e.what()},{"returnTo",jp(work)}});
  }
  return inventory();
}
J Engine::tidyMiningInventory(J inv){
  if(inv.value("empty_slots",36)>2||(inv.value("empty_slots",36)>0&&blocksDug-inventoryCleanupAt<8))return inv;
  inventoryCleanupAt=blocksDug;
  // Preserve mined resources by packing bulky mineral stacks before disposal.
  // A full bag must not be denied maintenance by the usual dig interval.
  P compactReturn=point(status()["pos"]);J packed=J::array();
  for(auto item:{"redstone","lapis_lazuli"}){
    int have=count(inv,item);if(have<128)continue;
    std::string product=std::string(item)=="redstone"?"redstone_block":"lapis_block";
    // The public server processes at most 64 recipe rounds per request.
    int amount=std::min(64,have/9);
    try{craft(product,amount,J(),false);inv=inventory();packed.push_back({{"item",item},{"blocks",amount}});}
    catch(const Failure& e){if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled")throw;progress("mining_inventory_warning",{{"code",e.code},{"message",e.what()},{"item",item}});inv=inventory();}
  }
  if(!packed.empty()){reclaimWorkbench();if(point(status()["pos"])!=compactReturn)navigate(compactReturn,false);inv=inventory();progress("mining_inventory_compacted",{{"items",packed},{"emptySlots",inv.value("empty_slots",-1)},{"returnTo",jp(compactReturn)}});if(inv.value("empty_slots",36)>2)return inv;}
  // Keep a stack of reliable building blocks, preferring cobblestone. All
  // ores, tools, food, wood and equipment are outside this explicit list.
  int reserve=64;J plan;auto planDrops=[&](){reserve=64;plan=J::array();for(const auto& n:RUBBLE){int have=count(inv,n),keep=0;if(n!="gravel"&&n!="sand"&&n!="red_sand"&&n!="leaf_litter"&&n!="wildflowers"){keep=std::min(reserve,have);reserve-=keep;}if(have>keep)plan.push_back({{"item",n},{"count",have-keep}});}};planDrops();
  if(plan.empty())return inv;
  auto s=status();const double yaw=s.value("yaw",0.0);P work=point(s["pos"]),disposal=work;bool turned=false;
  // /dig collect:true gathers all nearby drops, not just the ore. Discard
  // beyond that four-block collection radius along already walkable routes.
  std::vector<P> candidates;for(P d:dirs)candidates.push_back(add(work,{6*d[0],0,6*d[2]}));
  auto cells=state.value("traversedCells",J::object());for(auto it=cells.begin();it!=cells.end();++it){auto prefix=dimension+":";if(it.key().rfind(prefix,0)!=0)continue;auto q=J::parse(it.key().substr(prefix.size()),nullptr,false);if(q.is_discarded()||!q.is_array()||q.size()!=3)continue;P p=point(q);if(p[1]==work[1]&&distance(work,p)>=6&&distance(work,p)<=9)candidates.push_back(p);}
  std::stable_sort(candidates.begin(),candidates.end(),[&](P a,P b){return distance(work,a)<distance(work,b);});
  int attempts=0;for(P p:candidates){if(attempts>=4)break;if(!stand(p))continue;attempts++;try{navigate(p,false);disposal=p;break;}catch(const Failure& e){if(!recoverable(e))throw;if(point(status()["pos"])!=work)navigate(work,false);}}
  if(disposal==work){progress("mining_inventory_warning",{{"code","disposal_site_unavailable"},{"message","已知通道没有距离工作面至少6格的可达清槽点，保留物资，不在原地反复丢捡"}});return inv;}
  try{
    inv=inventory();planDrops();
    api("look",{{"x",2*disposal[0]-work[0]+0.5},{"y",disposal[1]+1.5},{"z",2*disposal[2]-work[2]+0.5}});turned=true;
    J removed=J::array();for(const auto& entry:plan){std::string item=entry["item"];int before=count(inv,item),requested=entry["count"];api("drop",{{"item",item},{"count",requested}});inv=inventory();int actual=before-count(inv,item);if(actual<requested)throw Failure("drop_incomplete","自动清槽后库存未按预期减少",{{"item",item},{"requested",requested},{"removed",actual}});removed.push_back({{"item",item},{"removed",actual}});if(inv.value("empty_slots",0)>=6)break;}
    navigate(work,false);api("look",{{"yaw",yaw},{"pitch",0}});turned=false;inv=inventory();
    progress("mining_inventory_maintenance",{{"items",removed},{"emptySlots",inv.value("empty_slots",-1)},{"reservedBlocks",64-reserve},{"disposal",jp(disposal)},{"returnTo",jp(work)}});
  }catch(const Failure& e){
    if(turned)try{api("look",{{"yaw",yaw},{"pitch",0}});}catch(const Failure&){}
    if(e.code=="dead"||e.code=="survival_priority"||e.code=="cancelled")throw;
    if(point(status()["pos"])!=work)navigate(work,false);
    progress("mining_inventory_warning",{{"code",e.code},{"message",e.what()}});inv=inventory();
  }
  return inv;
}
J Engine::gather(const J& p,bool wood){
  if(wood)return harvestTrees(p);
  std::vector<std::string> types=wood?std::vector<std::string>{"oak_log","birch_log","spruce_log","jungle_log","acacia_log","dark_oak_log","mangrove_log","cherry_log","pale_oak_log"}:std::vector<std::string>{"iron_ore","deepslate_iron_ore"};
  if(p.contains("types"))types=p["types"].get<std::vector<std::string>>();if(types.empty()||types.size()>24)throw Failure("bad_args","采集种类数量不符");for(auto n:types)if(wood?!ends(n,"_log"):!ends(n,"_ore")&&!std::set<std::string>{"stone","cobblestone","deepslate","cobbled_deepslate"}.count(n))throw Failure("bad_args","采集脚本仅允许原木、矿石或明确指定的石料");
  int target=p.value("targetCount",wood?32:16);if(target<1||target>256)throw Failure("bad_args","背包总目标须在1到256之间");int radius=std::clamp(p.value("radius",24),4,64);int explore=std::clamp(p.value("exploreSteps",6),0,16);
  std::set<std::string> drops;for(auto n:types)drops.insert(dropFor(n));auto total=[&](){
    auto inv=inventory();int sum=0;bool room=false;
    auto inspect=[&](){sum=0;room=inv.value("empty_slots",1)>0;for(auto n:drops){sum+=count(inv,n);for(auto item:inv.value("items",J::array()))if(name(item)==n&&item.value("count",64)<64)room=true;}};inspect();
    // Do not compact the very resource whose already-reached total ends this
    // job, or perform bag maintenance when its target stack still has room.
    if(sum<target&&!room){inv=tidyMiningInventory(inv);inspect();if(sum<target&&!room)throw Failure("inventory_full","目标物品既无空位也无可叠加空间，已尝试本地清槽");}return sum;
  };
  int current=total(),mined=0,explored=0;const int initialCount=current;P origin=point(status()["pos"]);std::set<P> rejected,visited{origin};J failures=J::array();long long lastDig=clockms();double perBlock=2000;
  progress("gather",{{"currentCount",current},{"targetCount",target},{"workCompleted",0},{"workTotal",std::max(0,target-initialCount)}});
  while(current<target){
    auto s=status();P feet=point(s["pos"]);auto found=api("findBlocks",{{"types",types},{"radius",radius},{"limit",64}});auto blocks=found.value("blocks",J::array());if(!blocks.is_array())throw Failure("protocol_error","带 types 的 find_blocks 必须返回方块列表");
    std::vector<J> candidates;for(auto b:blocks)if(b.contains("pos")&&!rejected.count(point(b["pos"]))&&!protectedAt(point(b["pos"])))candidates.push_back(b);
    std::sort(candidates.begin(),candidates.end(),[&](const J&a,const J&b){return distance(feet,point(a["pos"]))<distance(feet,point(b["pos"]));});bool worked=false;
    for(auto b:candidates){P pos=point(b["pos"]);try{
      auto live=block(pos,true);if(std::find(types.begin(),types.end(),name(live))==types.end()){rejected.insert(pos);continue;}
      approach(pos);tool(wood,name(live));dig(pos,true);mined++;worked=true;
      current=total();perBlock=perBlock*.6+(clockms()-lastDig)*.4;lastDig=clockms();
      // Pickup is an API-side action; if the item fell below, visit a verified
      // standing cell beside it rather than declaring block removal success.
      if(current<target&&mined%3==0){auto items=api("getEntities",{{"radius",6},{"types",J::array({"item"})}});for(auto e:items.value("entities",J::array()))if(e.contains("pos")&&drops.count(entityItem(e.value("item",std::string())))){P q=point(e["pos"]);if(stand(q))navigate(q);}}
      progress("gather",{{"currentCount",current},{"targetCount",target},{"mined",mined},{"workCompleted",std::max(0,current-initialCount)},{"workTotal",std::max(0,target-initialCount)},{"remainingMs",std::max(0.0,(target-current)*perBlock)},{"nearEnd",(target-current)*perBlock<=4000},{"failures",failures}});break;
    }catch(const Failure&e){if(!recoverable(e))throw;rejected.insert(pos);failures.push_back({{"pos",jp(pos)},{"code",e.code}});if(failures.size()>8)failures.erase(failures.begin());}}
    if(worked)continue;
    if(explored++>=explore)throw Failure("resource_unavailable","目标资源不可安全触及；已停止局部探索",{{"currentCount",current},{"targetCount",target},{"mined",mined},{"rejected",failures}});
    bool moved=false;for(auto v:dirs){P q=add(feet,{v[0]*9,0,v[2]*9});if(visited.count(q)||distance(q,origin)>48)continue;visited.insert(q);if(!stand(q))continue;try{navigate(q);moved=true;break;}catch(const Failure&e){if(!recoverable(e))throw;}}
    if(!moved)throw Failure("resource_unavailable","没有目标资源或安全的中距探索位置",{{"currentCount",current},{"mined",mined},{"rejected",failures}});
  }
  progress("finished",{{"currentCount",current},{"targetCount",target},{"mined",mined},{"remainingMs",0}});return {{"currentCount",current},{"targetCount",target},{"mined",mined}};
}
J Engine::fishbone(const J& p){
  const bool avoidCaves=p.value("avoidCaves",false)&&!hasIronArmor(inventory());
  const std::set<std::string> allowedStops={"lane_complete","danger","no_tool","inventory_full"};std::set<std::string> stopWhen={"lane_complete","danger","no_tool","inventory_full"};
  if(p.contains("stopWhen")){if(!p["stopWhen"].is_array()||p["stopWhen"].empty())throw Failure("bad_args","stopWhen 必须是非空退出条件数组");stopWhen.clear();for(const auto& x:p["stopWhen"]){if(!x.is_string()||!allowedStops.count(x.get<std::string>()))throw Failure("bad_args","鱼骨退出条件只支持 lane_complete/danger/no_tool/inventory_full");stopWhen.insert(x.get<std::string>());}stopWhen.insert("danger");stopWhen.insert("no_tool");stopWhen.insert("inventory_full");}
  auto initialStatus=status(false);P origin=point(initialStatus["pos"]),v{};std::string lane=p.value("laneId",p.value("anchor",std::string("1"))),label="fishbone:"+lane;int length=std::clamp(p.value("length",512),1,512),branch=std::clamp(p.value("branchLength",8),1,32),every=std::clamp(p.value("branchEvery",3),2,10),startDug=blocksDug,done=0;std::string stopReason;
  bool diamondSession=false;
  if(!stateFile.empty()){std::ifstream in(std::filesystem::path(stateFile).parent_path()/"debug-session.json");if(in.good())try{J session;in>>session;diamondSession=session.value("active",false)&&session.value("deadline",0LL)>wallms()&&session.value("goal",std::string())=="tactical-then-diamond-armor-portal";}catch(const J::exception&){} }
  auto armorMaterialsReady=[&](const J& inv){
    if(!diamondSession)return false;int required=0;
    for(const auto& part:std::vector<std::pair<std::string,int>>{{"helmet",5},{"chestplate",8},{"leggings",7},{"boots",4}}){bool owned=count(inv,"diamond_"+part.first)>0||count(inv,"netherite_"+part.first)>0;for(const auto& worn:inv.value("armor",J::object()))if(worn.is_object()&&(name(worn)=="diamond_"+part.first||name(worn)=="netherite_"+part.first))owned=true;if(!owned)required+=part.second;}
    if(required==0)return false;
    if(!count(inv,"diamond_pickaxe")&&!count(inv,"netherite_pickaxe"))required+=3;
    if(count(inv,"diamond")<required)return false;
    progress("mining_goal_ready",{{"goal","diamond_armor"},{"availableDiamonds",count(inv,"diamond")},{"requiredDiamonds",required},{"laneId",lane}});return true;
  };
  auto terminated=[&](){
    if(!stopReason.empty())return true;
    try{auto s=status();if(stopWhen.count("danger")&&(s.value("in_lava",false)||s.value("on_fire",false)||s.value("health",20.0)<6)){stopReason="danger";return true;}}
    catch(const Failure& e){if(e.code=="dead"||e.code=="not_ready"){stopReason="danger";return true;}throw;}
    if(stopWhen.count("no_tool")||stopWhen.count("inventory_full")){auto inv=inventory();if(armorMaterialsReady(inv)){stopReason="target_reached";return true;}inv=tidyMiningInventory(inv);if(inv.value("empty_slots",1)>0)inv=maintainMiningTools(inv);if(stopWhen.count("inventory_full")&&inv.value("empty_slots",1)<=0){stopReason="inventory_full";return true;}if(stopWhen.count("no_tool")){bool hasPick=false;for(auto tier:{"netherite","diamond","iron","stone","wooden","golden"})if(count(inv,std::string(tier)+"_pickaxe")>0)hasPick=true;if(!hasPick){stopReason="no_tool";return true;}}}
    return false;
  };
  if(state["fishboneRoutes"].contains(label)&&state["fishboneRoutes"][label].is_object())v=point(state["fishboneRoutes"][label].value("direction",J::array()));else if(p.contains("direction"))v=direction(p);else {double yaw=initialStatus.value("yaw",0.0);v={int(std::lround(-std::sin(yaw))),0,int(std::lround(std::cos(yaw)))};if(std::abs(v[0])+std::abs(v[2])!=1)v={0,0,1};}
  static const std::vector<std::string> oreDrops={"coal","raw_iron","raw_copper","raw_gold","redstone","lapis_lazuli","diamond","emerald","quartz"};
  auto oreCount=[&](){auto inv=inventory();int sum=9*(count(inv,"redstone_block")+count(inv,"lapis_block"));for(const auto& name:oreDrops)sum+=count(inv,name);return sum;};int startingOreCount=oreCount();auto oreMined=[&](){return std::max(0,oreCount()-startingOreCount);};auto needsMore=[&](){return !terminated();};
  static const J allOres=J::array({"coal_ore","deepslate_coal_ore","iron_ore","deepslate_iron_ore","copper_ore","deepslate_copper_ore","gold_ore","deepslate_gold_ore","redstone_ore","deepslate_redstone_ore","lapis_ore","deepslate_lapis_ore","diamond_ore","deepslate_diamond_ore","emerald_ore","deepslate_emerald_ore","nether_quartz_ore","nether_gold_ore"});
  auto& saved=state["fishboneRoutes"][label];const bool same=saved.is_object()&&saved.value("dimension",dimension)==dimension&&saved.value("direction",jp(v))==jp(v);
  // Before any lane cell has been excavated, its origin is provisional.
  // A caller moving to a new rock face must not get dragged back to an old
  // zero-progress cave-edge checkpoint. Committed lanes never move or turn.
  if(!terminated()&&(!same||(saved.value("mainStep",0)==0&&!saved.value("mainFinished",false)&&saved.value("branches",J::array()).empty()))){
    auto entryWorks=[&](P start,P d){
      P next=add(start,d);observe({add(next,{0,-1,0}),next,add(next,{0,1,0})},true);
      if(!support(block(add(next,{0,-1,0})))||protectedAt(next)||protectedAt(add(next,{0,1,0})))return false;
      for(P q:{next,add(next,{0,1,0})})if(!air(block(q))&&(!terrain(block(q))||important(block(q))))return false;
      if(air(block(next))&&air(block(add(next,{0,1,0}))))return false;
      return !avoidCaves||!exposedAhead(next,d);
    };
    const P current=point(status()["pos"]);P selected=origin;P selectedDir=v;bool found=false;
    std::vector<P> starts{current};if(same&&point(saved["origin"])!=current)starts.push_back(point(saved["origin"]));
    for(P start:starts){if(!stand(start))continue;std::vector<P> choices{v};for(P d:dirs)if(d!=v)choices.push_back(d);
      for(P d:choices)if(entryWorks(start,d)){selected=start;selectedDir=d;found=true;break;}if(found)break;
    }
    if(!found)throw Failure("mine_entry_unavailable","附近四向均没有适合起矿道的实心岩壁；先移动到岩壁边，未开挖或改写已施工矿道",{{"laneId",lane},{"position",jp(current)}});
    if(selected!=current)navigate(selected,false);origin=selected;v=selectedDir;
    if(same){saved["origin"]=jp(origin);saved["end"]=jp(origin);saved["direction"]=jp(v);saved["phase"]="main";saved.erase("lastPos");saved["entryVerifiedAt"]=wallms();save();}
    progress("fishbone_entry",{{"laneId",lane},{"origin",jp(origin)},{"direction",jp(v)}});
  }
  if(!same){saved={{"laneId",lane},{"dimension",dimension},{"origin",jp(origin)},{"end",jp(origin)},{"direction",jp(v)},{"length",length},{"branchLength",branch},{"branchEvery",every},{"phase","main"},{"mainStep",0},{"branchHub",every},{"branchSign",0},{"branchStep",0},{"branches",J::array()}};save();}
  P side={-v[2],0,v[0]};
  origin=point(saved["origin"]);P mainEnd=point(saved["end"]);int mainStep=saved.value("mainStep",0),branchHub=saved.value("branchHub",every),branchSign=saved.value("branchSign",0),branchStep=saved.value("branchStep",0);std::string phase=saved.value("phase",std::string("main"));
  length=std::clamp(saved.value("length",length),1,512);branch=std::clamp(saved.value("branchLength",branch),1,32);every=std::clamp(saved.value("branchEvery",every),2,10);
  auto completedWork=[&](){int n=mainStep;for(const auto& b:saved.value("branches",J::array()))if(b.contains("hub")&&b.contains("end"))n+=std::min(branch,int(std::lround(distance(point(b["hub"]),point(b["end"])))));return n;};
  const int initialWork=completedWork();
  auto localBoundary=[&](const Failure& e){return std::set<std::string>{"open_space_ahead","unsafe_excavation","falling_block_risk","unsafe_navigation","protected_workarea"}.count(e.code)>0;};
  auto timedProgress=[&](std::string phase,J fields){int mainLength=saved.value("mainFinished",false)?mainStep:length;fields["workCompleted"]=std::max(0,completedWork()-initialWork);fields["workTotal"]=std::max(0,mainLength+2*(mainLength/every)*branch-initialWork);progress(phase,fields);};
  timedProgress("fishbone_layout",{{"laneId",lane},{"origin",jp(origin)},{"end",jp(mainEnd)}});
  auto exploreDetour=[&](P checkpoint){
    if(avoidCaves)return;
    exploreMiningCave(checkpoint,saved["caveDetour"],"fishbone:"+lane);
  };
  if(saved.contains("caveDetour")&&saved["caveDetour"].is_object()&&saved["caveDetour"].value("active",false))exploreDetour(point(saved["caveDetour"]["checkpoint"]));
  bool swept=false;P lastSweep{};int sweptAt=-1;
  auto sweepNearby=[&](P returnTo){
    if((swept&&lastSweep==returnTo&&sweptAt==blocksDug)||terminated())return;
    std::set<P> rejected, failed;
    const auto sweepStarted=clockms();
    int attempts=0;
    auto canTryMore=[&](){return attempts<3&&(attempts==0||clockms()-sweepStarted<8000);};
    while(canTryMore()&&!terminated()){
      auto scan=api("findBlocks",{{"types",allOres},{"radius",6},{"limit",64}});auto list=scan.value("blocks",J::array());if(!list.is_array())throw Failure("protocol_error","鱼骨矿物扫描未返回方块列表");
      std::vector<J> candidates;
      for(auto b:list){
        if(!b.contains("pos"))continue;
        const P q=point(b["pos"]);
        if(rejected.count(q)||failed.count(q)||protectedAt(q))continue;
        const auto key=dimension+":"+jp(q).dump();
        const auto memo=state["deferredOres"].value(key,J::object());
        if(memo.value("type",std::string())==name(b)&&
           memo.value("retryAfter",0LL)>wallms()&&memo.contains("checkpoint")&&
           distance(point(memo["checkpoint"]),returnTo)<=2)continue;
        candidates.push_back(b);
      }
      if(candidates.empty())break;
      auto rankingStatus=status(false);P feet=point(rankingStatus["pos"]);auto rankingInventory=inventory();std::stable_sort(candidates.begin(),candidates.end(),[&](const J&a,const J&b){return orePriority(feet,point(a["pos"]),name(a),rankingInventory,rankingStatus.value("xp_level",30))>orePriority(feet,point(b["pos"]),name(b),rankingInventory,rankingStatus.value("xp_level",30));});bool mined=false;
      for(const auto& b:candidates){
        if(!canTryMore()||terminated())break;
        const P q=point(b["pos"]);
        const auto live=block(q,true);
        if(std::find(allOres.begin(),allOres.end(),name(live))==allOres.end()){rejected.insert(q);continue;}
        const std::vector<P> neighbors={add(q,{1,0,0}),add(q,{-1,0,0}),add(q,{0,1,0}),add(q,{0,-1,0}),add(q,{0,0,1}),add(q,{0,0,-1})};
        observe(neighbors);
        if(std::none_of(neighbors.begin(),neighbors.end(),[&](P n){return air(block(n));})){rejected.insert(q);continue;}
        ++attempts;
        try{
          harvestOre(q);
          mined=true;
          rejected.clear();
          break;
        }catch(const Failure& e){
          failed.insert(q);
          if(e.code=="insufficient_tool_tier"){deferOre(q,name(live),e.details.value("requiredTier",3));continue;}
          if(e.code=="missing_tool"&&stopWhen.count("no_tool")){stopReason="no_tool";break;}
          if((e.code=="survival_priority"&&stopWhen.count("danger"))||e.code=="dead"||e.code=="not_ready"){stopReason="danger";break;}
          if(e.code=="inventory_full"){stopReason="inventory_full";break;}
          static const std::set<std::string> accessFailures={"no_path","stalled","not_visible","no_line_of_sight","dig_unconfirmed","dig_not_applied","protected_region","undiggable"};
          if(!recoverable(e)&&!accessFailures.count(e.code))throw;
          const auto at=wallms();
          state["deferredOres"][dimension+":"+jp(q).dump()]={{"pos",jp(q)},{"dimension",dimension},{"type",name(live)},{"reason",e.code},{"observedAt",at},{"checkpoint",jp(returnTo)},{"retryAfter",at+45000}};
          save();
        }
      }
      if(!stopReason.empty()||!mined)break;
    }
    if(terminated()||!stopReason.empty())return;restoreMiningPosition(returnTo);
    illuminate(returnTo,v);exploreDetour(returnTo);swept=true;lastSweep=returnTo;sweptAt=blocksDug;
  };
  sweepNearby(saved.contains("lastPos")?point(saved["lastPos"]):mainEnd);
  // Complete a recorded stretch and its branches before extending the same
  // axis. A 512-cell trunk alone consumes many tools without exposing sides.
  while(needsMore()){
  const bool resumeBranches=saved.value("phase",std::string("main"))=="branches"||(mainStep>=32&&branchHub<=mainStep);
  const int stretchEnd=resumeBranches?mainStep:std::min(length,((mainStep/32)+1)*32);
  for(int i=mainStep+1;!saved.value("mainFinished",false)&&i<=stretchEnd&&needsMore();i++){
    P hub=add(origin,{v[0]*i,0,v[2]*i});if(point(status(false)["pos"])!=mainEnd)navigate(mainEnd);sweepNearby(mainEnd);if(!needsMore())break;
    try{corridor(hub,"",!avoidCaves,false);}catch(const Failure&e){
      if(localBoundary(e)){
        saved["mainFinished"]=true;saved["mainBlocked"]={{"code",e.code},{"pos",jp(hub)},{"details",e.details},{"at",wallms()}};saved["phase"]="branches";save();
        restoreMiningPosition(mainEnd);
        timedProgress("fishbone_main_boundary",{{"laneId",lane},{"end",jp(mainEnd)},{"blockedAt",jp(hub)},{"reason",e.code}});break;
      }
      if((e.code=="survival_priority"&&stopWhen.count("danger"))||(e.code=="missing_tool"&&stopWhen.count("no_tool"))){stopReason=e.code=="missing_tool"?"no_tool":"danger";break;}throw;
    }
    mainEnd=hub;mainStep=i;saved["end"]=jp(mainEnd);saved["mainStep"]=mainStep;saved["phase"]="main";save();done++;
    saved["lastPos"]=jp(mainEnd);save();sweepNearby(mainEnd);timedProgress("fishbone_main",{{"completed",done},{"total",length},{"origin",jp(origin)},{"end",jp(mainEnd)},{"laneId",lane},{"blocksDug",blocksDug-startDug},{"oresCollected",oreMined()}});
  }
  if(mainStep>=length)saved["mainFinished"]=true;
  if(needsMore()&&branchHub<=mainStep){
    saved["phase"]="branches";save();
    for(int h=branchHub;h<=mainStep&&needsMore();h+=every){
      P hub=add(origin,{v[0]*h,0,v[2]*h});if(point(status(false)["pos"])!=hub)navigate(hub);sweepNearby(hub);
      for(int si=branchSign;si<2&&needsMore();si++){
        int sign=si==0?-1:1;P branchEnd=add(hub,{side[0]*branchStep*sign,0,side[2]*branchStep*sign});
        J* record=nullptr;for(auto& entry:saved["branches"])if(entry.value("hub",J())==jp(hub)&&entry.value("sign",0)==sign){record=&entry;break;}
        if(!record){saved["branches"].push_back({{"hub",jp(hub)},{"end",jp(branchEnd)},{"sign",sign}});record=&saved["branches"].back();}
        if(!record->value("complete",false)){
          if(point(status(false)["pos"])!=branchEnd)navigate(branchEnd);
          for(int step=branchStep+1;step<=branch&&needsMore();step++){
            sweepNearby(branchEnd);if(!needsMore())break;P next=add(hub,{side[0]*step*sign,0,side[2]*step*sign});
            try{corridor(next,"",!avoidCaves,false);}catch(const Failure&e){
              if(localBoundary(e)){
                (*record)["complete"]=true;(*record)["blocked"]={{"code",e.code},{"pos",jp(next)},{"details",e.details},{"at",wallms()}};save();
                restoreMiningPosition(branchEnd);
                timedProgress("fishbone_branch_boundary",{{"laneId",lane},{"hub",jp(hub)},{"end",jp(branchEnd)},{"blockedAt",jp(next)},{"reason",e.code}});break;
              }
              if((e.code=="survival_priority"&&stopWhen.count("danger"))||(e.code=="missing_tool"&&stopWhen.count("no_tool"))){stopReason=e.code=="missing_tool"?"no_tool":"danger";break;}throw;
            }
            branchEnd=next;branchStep=step;(*record)["end"]=jp(branchEnd);if(step>=branch)(*record)["complete"]=true;
            saved["lastPos"]=jp(branchEnd);saved["branchHub"]=h;saved["branchSign"]=si;saved["branchStep"]=step;save();sweepNearby(branchEnd);
            timedProgress("fishbone_branch",{{"hub",jp(hub)},{"end",jp(branchEnd)},{"laneId",lane},{"blocksDug",blocksDug-startDug},{"oresCollected",oreMined()}});
          }
        }
        if(!stopReason.empty())break;
        branchStep=0;saved["branchStep"]=0;saved["branchSign"]=si+1;save();
        if(needsMore()){if(point(status(false)["pos"])!=hub)navigate(hub);saved["lastPos"]=jp(hub);save();sweepNearby(hub);}
      }
      if(!stopReason.empty())break;branchSign=0;branchHub=h+every;saved["branchSign"]=0;saved["branchHub"]=branchHub;save();
    }
  }
  if(!needsMore()||(saved.value("mainFinished",false)&&branchHub>mainStep))break;
  saved["phase"]="main";save();
  }
  P endpoint=saved.contains("lastPos")?point(saved["lastPos"]):mainEnd;if(stopReason=="target_reached")restoreMiningPosition(endpoint);state["anchors"][label+":origin"]={{"pos",jp(origin)},{"dimension",dimension},{"verifiedAt",wallms()}};state["anchors"][label+":end"]={{"pos",jp(mainEnd)},{"dimension",dimension},{"verifiedAt",wallms()}};saved["lastPos"]=jp(endpoint);const bool laneComplete=saved.value("mainFinished",false)&&saved.value("branchHub",branchHub)>mainStep;if(laneComplete)saved["phase"]="complete";save();if(stopReason.empty())stopReason=laneComplete?"lane_complete":"resume_required";return {{"laneId",lane},{"completed",done},{"origin",jp(origin)},{"mainEnd",jp(mainEnd)},{"currentPos",jp(endpoint)},{"oresCollected",oreMined()},{"targetReached",laneComplete},{"stopReason",stopReason},{"route",saved}};
}
J Engine::buildWorkarea(const J& p){
  P origin=point(status()["pos"]);if(p.contains("entrance")){navigate(point(p["entrance"]));origin=point(status()["pos"]);}P preferred=direction(p);std::string label=p.value("name",std::string("家"));
  // Keep a single construction site per name. A navigation/API warning must
  // resume this exact geometry instead of selecting a fresh wall.
  if(state["workareaBuilds"].contains(label)&&state["workareaBuilds"][label].value("complete",false)){
    for(auto& area:state["workareas"])if(area.value("name",std::string())==label&&area.value("dimension",std::string())==dimension)return area;
  }
  auto walls=api("findBlocks",{{"types",J::array({"stone","deepslate","dirt","grass_block","cobblestone","cobbled_deepslate","tuff","granite","diorite","andesite","netherrack","calcite"})},{"radius",16},{"limit",64}}).value("blocks",J::array());
  std::vector<std::pair<P,P>> candidates;std::set<std::string> seen;
  for(auto wall:walls){if(!wall.contains("pos"))continue;P face=point(wall["pos"]);for(P d:dirs){P start=add(face,{-d[0],0,-d[2]});if(distance(origin,start)>12)continue;std::string key=jp(start).dump()+jp(d).dump();if(seen.insert(key).second)candidates.push_back({start,d});}}
  std::stable_sort(candidates.begin(),candidates.end(),[&](const auto&a,const auto&b){auto score=[&](const auto&c){P d=c.second;return distance(origin,c.first)+(d==preferred?0:0.25);};return score(a)<score(b);});
  if(candidates.size()>8)candidates.resize(8);
  struct Site{P start;P direction;int blocks;};std::vector<Site> sites;J rejected=J::array();
  for(const auto& candidate:candidates){P s=candidate.first,d=candidate.second;std::vector<P> volume;for(int a=1;a<=5;a++)for(int b=-2;b<=2;b++){P q=add(s,{d[0]*a+(-d[2])*b,0,d[2]*a+d[0]*b});for(int y=-1;y<=2;y++)volume.push_back(add(q,{0,y,0}));}observe(volume,true);
    bool ok=true;int solids=0,dug=0;std::string reason;
    if(!stand(s)){ok=false;reason="洞口没有已确认的站立空间";}
    for(int a=1;a<=5&&ok;a++)for(int b=-2;b<=2&&ok;b++){
      P q=add(s,{d[0]*a+(-d[2])*b,0,d[2]*a+d[0]*b});auto floor=block(add(q,{0,-1,0}));if(!support(floor)){ok=false;reason="洞室地面缺少连续支撑";break;}
      for(int y=0;y<2;y++){P c=add(q,{0,y,0});auto z=block(c);if(protectedAt(c)||(!air(z)&&(!terrain(z)||important(z)||!z.value("diggable",true)))){ok=false;reason="洞室内含保护区或不可安全开挖的方块";break;}if(!air(z)){dug++;if(a<=2)solids++;}}
      auto roof=block(add(q,{0,2,0}));if(!terrain(roof)||important(roof)){ok=false;reason="岩壁上方没有天然顶板";break;}
    }
    if(ok&&solids<8){ok=false;reason="候选点不是足够完整的天然岩壁";}
    if(ok)sites.push_back({s,d,dug});
    else if(rejected.size()<8)rejected.push_back({{"start",jp(s)},{"direction",jp(d)},{"reason",reason}});
  }
  const bool hasSavedBuild=state["workareaBuilds"].contains(label)&&state["workareaBuilds"][label].is_object()&&state["workareaBuilds"][label].contains("start");
  if(sites.empty()&&!hasSavedBuild)return {{"warning",true},{"code","workarea_site_unavailable"},{"message","附近未发现可安全开凿的天然岩壁；保持当前位置，请改选路线或之后重试"},{"rejected",rejected}};
  // Candidate wall, two-block room, support, overhead cover, and materials
  // are all checked before the first terrain-changing API call.
  auto inv=inventory();
  J required={{"crafting_table",1},{"furnace",1},{"chest",1}},missing=J::array(),needs=J::object();for(auto it=required.begin();it!=required.end();++it){std::string item=it.key();if(count(inv,item)>=1)continue;J recipe=recipes(item,1,inv);if(!recipe["missing"].empty()){missing.push_back({{"item",item},{"missing",recipe["missing"]}});continue;}for(auto r=recipe["needs"].begin();r!=recipe["needs"].end();++r)needs[r.key()]=needs.value(r.key(),0)+r.value().get<int>();}
  for(auto it=needs.begin();it!=needs.end();++it){int have=count(inv,it.key()),need=it.value().get<int>();if(have<need)missing.push_back({{"item",it.key()},{"need",need},{"available",have}});}if(!missing.empty())return {{"warning",true},{"code","workarea_materials_missing"},{"message","找到安全岩壁，但设施材料不足；尚未开挖"},{"missing",missing}};
  P start{},v{};int solidToDig=0;bool selected=false;
  if(state["workareaBuilds"].contains(label)&&state["workareaBuilds"][label].is_object()&&!state["workareaBuilds"][label].value("complete",false)){
    auto& saved=state["workareaBuilds"][label];
    if(saved.value("dimension",dimension)==dimension&&saved.contains("start")&&saved.contains("direction")){start=point(saved["start"]);v=point(saved["direction"]);solidToDig=saved.value("blocks",0);selected=true;}
  }
  if(!selected)for(const auto& site:sites){try{navigate(site.start,false);start=site.start;v=site.direction;solidToDig=site.blocks;selected=true;break;}catch(const Failure&e){if(e.code!="path_not_found"&&e.code!="navigation_failed"&&e.code!="unreachable"&&e.code!="no_path"&&e.code!="stalled")throw;if(rejected.size()<16)rejected.push_back({{"start",jp(site.start)},{"direction",jp(site.direction)},{"reason",e.what()},{"code",e.code}});}}
  if(!selected&&state["workareaBuilds"].contains(label)){
    auto& saved=state["workareaBuilds"][label];
    if(saved.contains("start")&&saved.contains("direction")){start=point(saved["start"]);v=point(saved["direction"]);solidToDig=saved.value("blocks",0);selected=true;}
  }
  if(!selected)return {{"warning",true},{"code","workarea_site_unreachable"},{"message","附近岩壁结构合格，但洞口均无法安全到达；尚未开挖"},{"rejected",rejected}};
  if(solidToDig>0&&count(inv,"wooden_pickaxe")==0&&count(inv,"stone_pickaxe")==0&&count(inv,"iron_pickaxe")==0&&count(inv,"diamond_pickaxe")==0&&count(inv,"netherite_pickaxe")==0)return {{"warning",true},{"code","workarea_missing_tool"},{"message","找到可达的安全岩壁，但缺少镐；尚未开挖"},{"start",jp(start)},{"blocksToDig",solidToDig}};
  P side={-v[2],0,v[0]};
  auto& build=state["workareaBuilds"][label];
  if(!build.is_object()||build.value("complete",false)||!build.contains("start")){build={{"name",label},{"dimension",dimension},{"start",jp(start)},{"direction",jp(v)},{"blocks",solidToDig},{"completed",0},{"phase","excavate"},{"complete",false}};save();}
  int done=std::clamp(build.value("completed",0),0,25);
  for(int a=1;a<=5;a++){
    P center=add(start,{v[0]*a,0,v[2]*a});
    try{corridor(center,"",true);int column=0;for(int b:{-1,-2,0,1,2}){int cell=(a-1)*5+column++;if(cell<done)continue;P q=add(center,{side[0]*b,0,side[2]*b});corridor(q,"",true);done=cell+1;build["completed"]=done;save();progress("build_workarea",{{"completed",done},{"total",25},{"resume",true}});}corridor(center,"",true);}
    catch(const Failure&e){if(recoverable(e)){build["completed"]=done;build["lastError"]={{"code",e.code},{"message",e.what()}};save();return {{"warning",true},{"code","workarea_incomplete"},{"message","工作区施工暂时受阻，保留原位置并从断点继续"},{"completed",done},{"total",25},{"resume",true},{"error",e.code}};}throw;}
  }
  std::vector<P> volume;for(int a=1;a<=5;a++)for(int b=-2;b<=2;b++)for(int y=-1;y<=2;y++)volume.push_back(add(start,{v[0]*a+side[0]*b,y,v[2]*a+side[2]*b}));P lo=volume.front(),hi=lo;for(P q:volume)for(int i=0;i<3;i++){lo[i]=std::min(lo[i],q[i]);hi[i]=std::max(hi[i],q[i]);}observe(volume,true);for(int a=1;a<=5;a++)for(int b=-2;b<=2;b++){P q=add(start,{v[0]*a+side[0]*b,0,v[2]*a+side[2]*b});safeStand(q);if(!air(block(add(q,{0,1,0})))||!terrain(block(add(q,{0,2,0}))))throw Failure("unsafe_workarea","洞室两格净空或顶板复核失败");}
  P home=add(start,{v[0]*2,0,v[2]*2});J area={{"name",label},{"dimension",dimension},{"min",jp(lo)},{"max",jp(hi)},{"facilities",J::object()},{"createdAt",wallms()}};state["workareas"].push_back(area);build["phase"]="facilities";save();navigate(home);anchor({{"name",label}});
  // Protection is committed before installing valuable facilities. A partial
  // furniture failure leaves the finished chamber protected and recoverable.
  int n=0;for(std::string kind:{"crafting_table","furnace","chest"}){if(state["workareas"].back()["facilities"].contains(kind)){n++;continue;}if(count(inventory(),kind)<1)craft(kind,1);std::vector<P> spots;for(int a:{1,2,3,4})for(int b:{-2,-1,0,1,2})spots.push_back(add(start,{v[0]*a+side[0]*b,0,v[2]*a+side[2]*b}));bool placed=false;for(P q:spots){if(!air(block(q,true)))continue;try{approach(q);place(q,kind);state["workareas"].back()["facilities"][kind]=jp(q);save();placed=true;break;}catch(const Failure&e){if(e.code=="dead"||e.code=="survival_priority")throw;}}if(!placed)return {{"warning",true},{"code","workarea_incomplete"},{"message","工作区已开凿，但设施位置暂时不可放置；保留现场后继续"},{"completed",25},{"total",25},{"resume",true}};n++;}
  build["phase"]="complete";build["complete"]=true;save();navigate(home);return state["workareas"].back();
}

J Engine::buildBase(const J& p){
  P feet=point(status()["pos"]);
  std::string label=p.value("name",std::string("临时基地"));if(label.empty())throw Failure("bad_args","基地需要名称");
  if(state["baseBuilds"].contains(label)&&state["baseBuilds"][label].value("complete",false)){
    for(auto& area:state["workareas"])if(area.value("name",std::string())==label&&area.value("dimension",std::string())==dimension&&area.contains("exit")&&area.contains("entrance")){
      P door=point(area["entrance"]);if(stand(point(area["exit"]))&&air(block(door,true))&&air(block(add(door,{0,1,0}),true)))return area;
    }
    if(state["baseBuilds"][label].value("dimension",std::string())==dimension){state["baseBuilds"][label]["complete"]=false;state["baseBuilds"][label]["phase"]="facilities";save();}
  }
  auto& build=state["baseBuilds"][label];
  const bool fresh=!build.is_object()||build.value("dimension",std::string())!=dimension||!build.contains("center");
  int width=std::clamp(p.value("width",5),3,9),depth=std::clamp(p.value("depth",5),3,9),wallHeight=std::clamp(p.value("wallHeight",3),2,5);
  std::string material=p.value("material",std::string());
  std::string style=p.value("style",std::string("plain"));
  if(!fresh){feet=point(build["center"]);width=build.value("width",width);depth=build.value("depth",depth);wallHeight=build.value("wallHeight",wallHeight);material=build.value("material",material);style=build.value("style",style);}
  else if(p.contains("center")){navigate(point(p["center"]));feet=point(status()["pos"]);}
  if(width%2==0||depth%2==0)throw Failure("bad_args","基地宽度和深度必须为奇数，便于保留中心落脚点");
  const int floorY=fresh?feet[1]-1:build.value("floorY",feet[1]-1),halfW=width/2,halfD=depth/2;
  if(material.empty())material=filler();else material=entityItem(material);
  auto inv=inventory();const int perimeter=2*(width+depth)-4,decoration=style=="cottage"?width:0,need=width*depth+perimeter*wallHeight+width*depth+decoration;
  if(fresh&&count(inv,material)<need)return {{"warning",true},{"code","base_materials_missing"},{"message","火柴盒基地需要更多建筑方块；尚未清空施工区"},{"material",material},{"need",need},{"available",count(inv,material)}};
  if(fresh){build={{"name",label},{"dimension",dimension},{"center",jp(feet)},{"floorY",floorY},{"width",width},{"depth",depth},{"wallHeight",wallHeight},{"material",material},{"style",style},{"phase","clear"},{"complete",false}};save();}
  P center=feet;const auto cell=[&](int dx,int dy,int dz){return P{center[0]+dx,floorY+dy,center[2]+dz};};
  if(!fresh&&point(status()["pos"])!=center)navigate(center,false);
  P exitDir=build.contains("exitDir")?point(build["exitDir"]):direction(p);
  if(!build.contains("exitDir")){
    // Prefer a doorway opening onto an existing corridor, preserving the
    // arrival topology instead of sealing all four perimeter walls.
    for(auto d:dirs){int span=d[0]?halfW:halfD;P outside=add(center,{d[0]*(span+1),0,d[2]*(span+1)});if(stand(outside)){exitDir=d;break;}}
    build["exitDir"]=jp(exitDir);save();
  }
  const int exitSpan=exitDir[0]?halfW:halfD;
  P doorway=add(center,{exitDir[0]*exitSpan,0,exitDir[2]*exitSpan}),outside=add(doorway,exitDir);
  auto doorRoute=[&](P q){if(q[1]!=center[1]&&q[1]!=center[1]+1)return false;for(int i=1;i<=exitSpan+1;i++)if(q[0]==center[0]+exitDir[0]*i&&q[2]==center[2]+exitDir[2]*i)return true;return false;};
  auto isEdge=[&](int x,int z){return std::abs(x)==halfW||std::abs(z)==halfD;};
  // First make the full construction volume safe to occupy. Existing
  // terrain is removed one cell at a time; important blocks are rejected by
  // Engine::dig instead of being silently overwritten.
  if(build.value("phase",std::string("clear"))=="clear"){
    for(int y=1;y<=wallHeight;y++)for(int x=-halfW;x<=halfW;x++)for(int z=-halfD;z<=halfD;z++){
      P q=cell(x,y,z);if(q==center||q==add(center,{0,1,0}))continue;auto b=block(q,true);if(!air(b)){if(important(b))continue;dig(q,true,false,false);}
    }
    build["phase"]="floor";save();progress("build_base",{{"stage","clear"},{"width",width},{"depth",depth}});
  }
  // Keep a two-block doorway and one verified exterior landing. This also
  // repairs an interrupted old shell whose wall stage sealed its entrance.
  for(P floor:{add(doorway,{0,-1,0}),add(outside,{0,-1,0})})if(!support(block(floor,true))){if(!air(block(floor)))throw Failure("unsafe_navigation","基地门外落脚处有液体或非实体障碍");place(floor,material);}
  for(P q:{add(doorway,{0,1,0}),doorway,add(outside,{0,1,0}),outside})if(!air(block(q,true))){
    tool(false,name(block(q)));
    // Only the exact doorway of this recorded shell can be repaired through
    // workarea protection. No model parameter can enable general base mining.
    if(q==doorway||q==add(doorway,{0,1,0}))doorwayRepairs.insert(q);
    try{dig(q,true,false,false);}catch(...){doorwayRepairs.erase(q);throw;}doorwayRepairs.erase(q);
  }
  build["entrance"]=jp(doorway);build["exit"]=jp(outside);save();
  if(build.value("phase",std::string())=="floor"){
    for(int x=-halfW;x<=halfW;x++)for(int z=-halfD;z<=halfD;z++){P q=cell(x,0,z);if(air(block(q,true)))place(q,material);}
    build["phase"]="walls";save();progress("build_base",{{"stage","floor"},{"width",width},{"depth",depth}});
  }
  if(build.value("phase",std::string())=="walls"){
    auto windowOpening=[&](int x,int y,int z){return style=="cottage"&&y==2&&((std::abs(x)==halfW&&z==0)||(std::abs(z)==halfD&&x==0));};
    for(int y=1;y<=wallHeight;y++)for(int x=-halfW;x<=halfW;x++)for(int z=-halfD;z<=halfD;z++)if(isEdge(x,z)){P q=cell(x,y,z);if(!doorRoute(q)&&!windowOpening(x,y,z)&&air(block(q,true)))place(q,material);}
    build["phase"]="roof";save();progress("build_base",{{"stage","walls"},{"width",width},{"depth",depth}});
  }
  if(build.value("phase",std::string())=="roof"){
    // Build the roof from the outer ring toward the centre so each placement
    // has a confirmed adjacent support block.
    for(int ring=0;ring<=std::max(halfW,halfD);ring++)for(int x=-halfW;x<=halfW;x++)for(int z=-halfD;z<=halfD;z++)if(std::max(std::abs(x),std::abs(z))==std::max(halfW,halfD)-ring){P q=cell(x,wallHeight,z);if(air(block(q,true)))place(q,material);}
    if(style=="cottage"){
      for(int x=-halfW;x<=halfW;x++){P q=cell(x,wallHeight+1,0);if(air(block(q,true)))place(q,material);}
      std::string glass=count(inventory(),"glass_pane")>0?"glass_pane":count(inventory(),"glass")>0?"glass":"";
      if(!glass.empty())for(P q:{cell(-halfW,2,0),cell(halfW,2,0),cell(0,2,-halfD),cell(0,2,halfD)})if(air(block(q,true))&&count(inventory(),glass)>0)place(q,glass);
    }
    build["phase"]="facilities";save();progress("build_base",{{"stage","roof"},{"width",width},{"depth",depth}});
  }
  if(build.value("phase",std::string())=="facilities"){
    std::vector<P> spots;for(int z=-halfD+1;z<=halfD-1;z++)for(int x=-halfW+1;x<=halfW-1;x++)spots.push_back(cell(x,1,z));
    for(std::string kind:{"crafting_table","furnace","chest"}){
      bool present=build.contains(std::string("facility_")+kind);for(auto& a:state["workareas"]){if(a.value("name",std::string())==label&&a.value("facilities",J::object()).contains(kind)){present=true;break;}}
      if(present)continue;if(count(inventory(),kind)<1)craft(kind,1);
      bool placed=false;P placedPos{};for(P q:spots){if(q==center||q==add(center,{0,1,0})||doorRoute(q)||!air(block(q,true)))continue;try{approach(q);place(q,kind);placed=true;placedPos=q;break;}catch(const Failure&e){if(e.code=="dead"||e.code=="survival_priority")throw;}}
      if(!placed)return {{"warning",true},{"code","base_incomplete"},{"message","基地外壳已完成，但设施暂时无法放置；保留现场后继续"},{"facility",kind}};
      build["facility_"+kind]=jp(placedPos);save();
    }
    P lo{center[0]-halfW,floorY,center[2]-halfD},hi{center[0]+halfW,floorY+wallHeight,center[2]+halfD};
    J area={{"name",label},{"dimension",dimension},{"min",jp(lo)},{"max",jp(hi)},{"facilities",J::object()},{"entrance",jp(doorway)},{"exit",jp(outside)},{"createdAt",wallms()}};
    for(auto kind:{"crafting_table","furnace","chest"})if(build.contains(std::string("facility_")+kind))area["facilities"][kind]=build[std::string("facility_")+kind];
    bool updated=false;for(auto& old:state["workareas"])if(old.value("name",std::string())==label&&old.value("dimension",std::string())==dimension){old=area;updated=true;break;}if(!updated)state["workareas"].push_back(area);build["phase"]="complete";build["complete"]=true;save();navigate(center,false);anchor({{"name",label},{"pos",jp(center)}});return area;
  }
  return state["workareas"].back();
}
J Engine::run(std::string job,const J& p){
  if(!p.is_object())throw Failure("bad_args","脚本参数必须为对象");progress("starting",{{"job",job}});
  if(job=="inventory_brief")return inventoryBrief(p.value("inventory",J::object()));
  if(job=="inspect_state")return state;
  if(job=="breathe")return breathe();
  if(job=="record_death"){setDeath(p.value("death",J::object()));return state;}
  // A cancelled tree job must get off its own scaffold before ordinary work
  // can navigate elsewhere. Survival and death recovery keep priority.
  if(job!="combat"&&job!="jump_attack"&&job!="survive"&&job!="recover_loot")recoverTreePillar();
  if(job!="combat"&&job!="jump_attack"&&job!="survive"&&job!="recover_loot"&&state.contains("oreScaffold")&&state["oreScaffold"].is_object()&&state["oreScaffold"].value("active",false)){status();recoverOreScaffold();}
  if(job=="explore_cave"||job=="gather_resources"){J q=p;q["mode"]=job=="explore_cave"?"cave":"surface";return explore(q);}
  if(job=="enchant_equipment"||job=="build_enchanting_area"){J q=p;q["mode"]=job=="build_enchanting_area"?"build":"enchant";return enchanting(q);}
  if(job=="chop_tree")return gather(p,true);if(job=="mine_vein")return gather(p,false);if(job=="fishbone_mine")return fishbone(p);if(job=="collect_drops")return collectDrops(p);
  if(job=="move_to"||job=="route_navigate"||job=="navigation_recover"){J q=p;if(!q.contains("target")&&!q.contains("to")){if(q.contains("pos"))q["target"]=q["pos"];else q["target"]=J::array({q.at("x"),q.at("y"),q.at("z")});}if(job=="navigation_recover")q["construct"]=true;return route(q);}
  if(job=="staircase_up"||job=="staircase_down"){
    bool up=job=="staircase_up";int steps=p.value("steps",8);P v=direction(p);
    const bool allowOpen=p.value("allowOpenSpace",true)||hasIronArmor(inventory());
    staircase(up,steps,v,p.value("material",std::string()),allowOpen);return {{"pos",status()["pos"]},{"direct",false}};
  }
  if(job=="bridge_to"){bridge(point(p.at("target")),p.value("material",std::string()));return {{"pos",status()["pos"]}};}
  if(job=="place"){std::string item=p.value("item",std::string());if(item.empty()||!p.contains("pos"))throw Failure("bad_args","place 需要 item 和 pos");P target=point(p["pos"]);if(item=="chest"||item=="furnace"||item=="crafting_table")target=placeFacility(item,target);else place(target,item);return {{"placed",item},{"pos",jp(target)}};}
  if(job=="pillar"){pillar(p.value("height",1),p.value("material",std::string()));return {{"pos",status()["pos"]}};}
  if(job=="build_workarea")return buildWorkarea(p);if(job=="build_house"){J q=p;q["style"]="cottage";if(!q.contains("name"))q["name"]="小家";return buildBase(q);}if(job=="build_base")return buildBase(p);if(job=="workshop")return workshop(p);if(job=="craft")return craft(p.at("item"),p.value("count",1),p.value("table",J()));
  if(job=="discard_items"){
    auto items=p.value("items",J::array());if(!items.is_array()||items.empty()||items.size()>24)throw Failure("bad_args","discard_items 需要1到24项");J result=J::array(),skipped=J::array();std::map<std::string,int> plan;auto inv=inventory();
    for(const auto& item:items){if(!item.is_object()||!item.contains("item")||!item["item"].is_string()||!item.contains("count")||!item["count"].is_number_integer())throw Failure("bad_args","丢弃条目需明确 item 和整数 count");std::string n=entityItem(item["item"].get<std::string>());int requested=item["count"];if(requested<1||requested>2304)throw Failure("bad_args","丢弃数量须为1到2304");if(std::find(RUBBLE.begin(),RUBBLE.end(),n)==RUBBLE.end()){skipped.push_back({{"item",n},{"code","protected_item"}});continue;}plan[n]+=requested;}
    if(plan.empty())throw Failure("protected_item","清槽仅允许普通石料泥沙，未执行任何丢弃",{{"skipped",skipped}});
    for(auto& entry:plan)if(entry.second>count(inv,entry.first)){if(p.value("strict",false))throw Failure("missing_item","整批丢弃预检发现数量不足，未执行任何丢弃",{{"item",entry.first},{"requested",entry.second},{"available",count(inv,entry.first)}});skipped.push_back({{"item",entry.first},{"code","count_clamped"},{"requested",entry.second},{"available",count(inv,entry.first)}});entry.second=count(inv,entry.first);}
    if(!skipped.empty())progress("discard_skipped_protected",{{"skipped",skipped},{"message","已跳过受保护物品，继续清理普通石料"}});
    for(const auto& entry:plan){int before=count(inventory(),entry.first),amount=std::min(entry.second,before);if(amount<1)continue;api("drop",{{"item",entry.first},{"count",amount}});int after=count(inventory(),entry.first);if(before-after<amount)throw Failure("drop_incomplete","丢弃后库存数量未按预期减少",{{"item",entry.first},{"requested",amount},{"removed",before-after}});result.push_back({{"item",entry.first},{"removed",before-after}});}return {{"items",result},{"skipped",skipped},{"emptySlots",inventory().value("empty_slots",-1)}};
  }
  if(job=="mark_anchor")return anchor(p);if(job=="combat"||job=="jump_attack")return combat(p);if(job=="survive")return survive(p);if(job=="maintain")return maintain(p);if(job=="recover_loot")return recover(p);
  if(job=="equip"){
    std::string slot=p.value("slot",std::string("hand"));
    static const std::map<std::string,std::string> aliases={{"chest","torso"},{"chestplate","torso"},{"helmet","head"},{"leggings","legs"},{"boots","feet"},{"offhand","off-hand"},{"mainhand","hand"}};
    if(aliases.count(slot))slot=aliases.at(slot);
    equip(p.at("item"),slot);return {{"equipped",p.at("item")},{"slot",slot}};
  }
  if(job=="workflow"){auto jobs=p.at("jobs");if(!jobs.is_array()||jobs.empty()||jobs.size()>24)throw Failure("bad_args","工作流需1到24项任务");J results=J::array();for(auto task:jobs){if(task.value("type",std::string())=="workflow")throw Failure("bad_args","工作流不可递归");results.push_back(run(task.at("type"),task.value("params",J::object())));}return results;}
  throw Failure("unknown_script","没有该 C++ 自动化脚本："+job);
}
}
