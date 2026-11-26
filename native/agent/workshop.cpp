#include "engine.hpp"
#include <functional>
namespace mc {
J Engine::recipes(std::string item,int requested,const J& inv){
  if(requested<1||requested>256)throw Failure("bad_args","合成产物数量需在1到256之间");J alternatives=J::array();int out=1;bool table=true,needsTotal=false;
  auto recipe=[&](J needs){alternatives.push_back(needs);};
  static const std::vector<std::string> woods={"oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak"};
  auto plankNeeds=[&](int required){
    J needs=J::object();auto choices=woods;
    std::stable_sort(choices.begin(),choices.end(),[&](const std::string&a,const std::string&b){return count(inv,a+"_planks")>count(inv,b+"_planks");});
    for(auto w:choices){int take=std::min(count(inv,w+"_planks"),required);if(take>0)needs[w+"_planks"]=take;required-=take;}
    if(required>0){std::string chosen="oak";int most=-1;for(auto w:woods){int logs=count(inv,w+"_log")+count(inv,w+"_wood");if(logs>most){most=logs;chosen=w;}}needs[chosen+"_planks"]=needs.value(chosen+"_planks",0)+required;}
    return needs;
  };
  if(ends(item,"_planks")){std::string w=item.substr(0,item.size()-7);if(std::find(woods.begin(),woods.end(),w)==woods.end())throw Failure("unsupported_recipe","未知木板配方");out=4;table=false;recipe({{w+"_log",1}});recipe({{w+"_wood",1}});}
  else if(item=="stick"||item=="crafting_table"||item=="chest"||item=="ladder"||item=="bowl"||item=="shield"){
    out=item=="stick"?4:item=="ladder"?3:item=="bowl"?4:1;table=item!="stick"&&item!="crafting_table";int need=item=="stick"?2:item=="crafting_table"?4:item=="chest"?8:item=="shield"?6:3;
    if(item=="ladder")recipe({{"stick",7}});else {int batches=(requested+out-1)/out;J needs=plankNeeds(need*batches);if(item=="shield")needs["iron_ingot"]=batches;recipe(needs);needsTotal=true;}
  }
  else if(item=="furnace"){recipe({{"cobblestone",8}});recipe({{"cobbled_deepslate",8}});}
  else if(item=="torch"){out=4;table=false;recipe({{"coal",1},{"stick",1}});recipe({{"charcoal",1},{"stick",1}});}
  else if(item=="bucket")recipe({{"iron_ingot",3}});
  else if(item=="shears"){table=false;recipe({{"iron_ingot",2}});}
  else if(item=="flint_and_steel"){table=false;recipe({{"iron_ingot",1},{"flint",1}});}
  else if(item=="bread")recipe({{"wheat",3}});
  else if(item=="paper"){out=3;recipe({{"sugar_cane",3}});}
  else if(item=="book"){table=false;recipe({{"paper",3},{"leather",1}});}
  else if(item=="bookshelf"){J needs=plankNeeds(6*requested);needs["book"]=3*requested;recipe(needs);needsTotal=true;}
  else if(item=="enchanting_table")recipe({{"obsidian",4},{"diamond",2},{"book",1}});
  else if(item=="redstone_block")recipe({{"redstone",9}});
  else if(item=="lapis_block")recipe({{"lapis_lazuli",9}});
  else if(item=="redstone"){table=false;out=9;recipe({{"redstone_block",1}});}
  else if(item=="lapis_lazuli"){table=false;out=9;recipe({{"lapis_block",1}});}
  else {
    std::string material,suffix;int units=0;for(auto tier:{"wooden","stone","iron","golden","diamond"})if(item.rfind(std::string(tier)+"_",0)==0){material=tier;suffix=item.substr(material.size()+1);break;}
    if(suffix=="pickaxe"||suffix=="axe")units=3;else if(suffix=="shovel")units=1;else if(suffix=="hoe"||suffix=="sword")units=2;else if(suffix=="helmet")units=5;else if(suffix=="chestplate")units=8;else if(suffix=="leggings")units=7;else if(suffix=="boots")units=4;
    if(units==0)throw Failure("unsupported_recipe","本地无可验证配方，拒绝试错调用 /craft："+item);
    std::string ingredient=material=="stone"?"cobblestone":material=="iron"?"iron_ingot":material=="golden"?"gold_ingot":"diamond";
    J needs=J::object();if(material=="wooden"){needs=plankNeeds(units*requested);needsTotal=true;}else needs[ingredient]=units;
    if(suffix=="sword")needs["stick"]=needsTotal?requested:1;else if(suffix=="pickaxe"||suffix=="axe"||suffix=="shovel"||suffix=="hoe")needs["stick"]=needsTotal?2*requested:2;recipe(needs);
    if(material=="stone")for(auto alternative:{"cobbled_deepslate","blackstone"}){auto other=needs;other.erase("cobblestone");other[alternative]=units;recipe(other);}
  }
  int batches=(requested+out-1)/out;J best,missing;int shortage=100000;
  for(auto needs:alternatives){J lack=J::array();int score=0;for(auto it=needs.begin();it!=needs.end();++it){int required=it.value().get<int>()*(needsTotal?1:batches);needs[it.key()]=required;int have=count(inv,it.key());if(have<required){score+=required-have;lack.push_back({{"item",it.key()},{"need",required},{"available",have}});}}
    if(score<shortage){best=needs;missing=lack;shortage=score;}}
  return {{"item",item},{"requested",requested},{"produced",out*batches},{"needs",best},{"missing",missing},{"table",table}};
}
P Engine::placeFacility(std::string kind,P preferred){
  P feet=point(status()["pos"]);std::vector<P> candidates{preferred};
  const std::string placementKey=dimension+":"+kind+":"+jp(preferred).dump();
  auto placements=state.value("facilityPlacements",J::object());if(placements.contains(placementKey))candidates.insert(candidates.begin(),point(placements[placementKey]));
  auto remember=[&](P q){state["facilityCache"][dimension+":"+kind]=jp(q);state["facilityPlacements"][placementKey]=jp(q);save();return q;};
  for(int dy:{0,1,-1})for(int radius=1;radius<=3;radius++)for(int dx=-radius;dx<=radius;dx++)for(int dz=-radius;dz<=radius;dz++)if(std::max(std::abs(dx),std::abs(dz))==radius)candidates.push_back(add(feet,{dx,dy,dz}));
  std::set<P> seen;
  for(P q:candidates){
    if(!seen.insert(q).second||distance(feet,q)>4||q==feet||q==add(feet,{0,1,0}))continue;
    bool doorway=false;for(const auto& area:state["workareas"])if(area.value("dimension",std::string())==dimension)for(auto key:{"entrance","exit"})if(area.contains(key)&&q==point(area[key]))doorway=true;if(doorway)continue;
    auto cell=block(q,true);if(name(cell)==kind){approach(q);return remember(q);}
    if(!air(cell)||!support(block(add(q,{0,-1,0}),true)))continue;
    if(kind=="chest"&&!air(block(add(q,{0,1,0}),true)))continue;
    try{place(q,kind);}catch(const Failure&e){if(e.code=="occupied"||e.code=="no_support"||e.code=="out_of_reach"||e.code=="out_of_range")continue;throw;}
    remember(q);
    progress("facility_placed",{{"item",kind},{"requested",jp(preferred)},{"pos",jp(q)},{"relocated",q!=preferred}});return q;
  }
  throw Failure("missing_facility_space","附近没有可安全放置工作站的位置，保留物品与现有设施",{{"item",kind},{"requested",jp(preferred)}});
}
P Engine::facility(std::string kind,const J& p){
  auto s=status();P feet=point(s["pos"]);if(p.contains("target")){
    auto t=p["target"];P q=point(t.is_array()?t:t.at("pos"));
    // Far facility coordinates are historical metadata, not loaded blocks.
    // Traverse verified medium legs first; query/open only after approaching.
    if(distance(feet,q)>8){
      P landing=q;bool recorded=false;for(const auto& area:state["workareas"]){if(area.value("dimension",std::string())!=dimension||!area.contains("entrance"))continue;for(const auto& pos:area.value("facilities",J::object()))if(pos.is_array()&&point(pos)==q){landing=point(area["entrance"]);recorded=true;break;}if(recorded)break;}
      if(!recorded){if(std::abs(feet[0]-q[0])>=std::abs(feet[2]-q[2]))landing[0]+=feet[0]>=q[0]?2:-2;else landing[2]+=feet[2]>=q[2]?2:-2;}
      progress("facility_approach",{{"kind",kind},{"target",jp(q)},{"landing",jp(landing)}});navigate(landing,false);
    }
    std::string actualKind=name(block(q,true));
    if(kind.empty()&&(actualKind=="chest"||actualKind=="furnace")){approach(q);return q;}
    if(actualKind!=kind){auto placements=state.value("facilityPlacements",J::object());auto key=dimension+":"+kind+":"+jp(q).dump();if(placements.contains(key)){P actual=point(placements[key]);if(name(block(actual,true))==kind)q=actual;else throw Failure("wrong_facility","已记录工作站位置的设施不再存在");}else throw Failure("wrong_facility","指定位置不是 "+kind);}
    approach(q);return q;
  }
  const std::string key=dimension+":"+kind;
  auto remember=[&](P q){if(state["facilityCache"].value(key,J())!=jp(q)){state["facilityCache"][key]=jp(q);save();}return q;};
  auto navigationFailure=[](const Failure& e){return std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation","no_progress"}.count(e.code)>0;};
  auto present=[&](P q){try{return name(block(q,true))==kind;}catch(const Failure& e){if(e.code=="not_loaded")return false;throw;}};
  std::set<P> rejected;
  std::vector<P> nearby;
  if(state.value("temporaryWorkbench",J()).is_object()&&kind=="crafting_table"&&state["temporaryWorkbench"].value("dimension",std::string())==dimension)nearby.push_back(point(state["temporaryWorkbench"]["pos"]));
  if(state["facilityCache"].contains(key))nearby.push_back(point(state["facilityCache"][key]));
  for(P q:nearby){if(distance(feet,q)>8||!rejected.insert(q).second)continue;if(!present(q))continue;try{approach(q);return remember(q);}catch(const Failure&e){if(!navigationFailure(e))throw;}}
  if(kind=="crafting_table"&&count(inventory(),kind)>0)throw Failure("missing_facility","使用随身工作台就地合成，不探测远处旧基地");
  // Use an already carried station locally before searching distant bases.
  if((kind=="furnace"||(kind=="chest"&&p.value("mode",std::string())=="store"))&&p.value("mode",std::string())!="take"&&count(inventory(),kind)>0){
    try{return remember(placeFacility(kind,add(feet,{1,0,0})));}
    catch(const Failure&e){if(e.code!="missing_facility_space")throw;}
  }
  std::vector<P> candidates;for(auto& a:state["workareas"])if(a.value("dimension",std::string())==dimension&&a.value("facilities",J::object()).contains(kind))candidates.push_back(point(a["facilities"][kind]));
  auto found=api("findBlocks",{{"types",J::array({kind})},{"radius",32},{"limit",8}});for(auto b:found.value("blocks",J::array()))if(b.contains("pos"))candidates.push_back(point(b["pos"]));std::sort(candidates.begin(),candidates.end(),[&](P a,P b){return distance(a,feet)<distance(b,feet);});
  for(P q:candidates){if(distance(feet,q)>32||!rejected.insert(q).second||!present(q))continue;try{approach(q);return remember(q);}catch(const Failure&e){if(!navigationFailure(e))throw;}}
  throw Failure("missing_facility","没有可达的 "+kind+"，先建造或指定工作区");
}
void Engine::reclaimWorkbench(){
  auto temporary=state.value("temporaryWorkbench",J());
  if(!temporary.is_object()||temporary.value("dimension",std::string())!=dimension)return;
  P pos=point(temporary["pos"]);
  // A bench adopted into a protected base is no longer a disposable station.
  if(protectedAt(pos)){state.erase("temporaryWorkbench");save();return;}
  if(distance(point(status()["pos"]),pos)>4)return;
  if(name(block(pos,true))!="crafting_table"){state.erase("temporaryWorkbench");save();return;}
  int before=count(inventory(),"crafting_table");
  api("dig",{{"pos",jp(pos)},{"collect",true}});
  if(!air(block(pos,true)))throw Failure("temporary_workbench_cleanup_failed","产物已合成，临时工作台尚未挖回",{{"pos",jp(pos)}});
  if(count(inventory(),"crafting_table")<=before)collectDrops({{"types",J::array({"crafting_table"})},{"radius",5}});
  bool recovered=count(inventory(),"crafting_table")>before;
  progress("temporary_workbench_cleanup",{{"pos",jp(pos)},{"recovered",recovered}});
  state.erase("temporaryWorkbench");save();
}
J Engine::craft(std::string item,int requested,J table,bool reclaim){
  auto inv=inventory();J simulated=inv;simulated["items"]=inv.value("items",J::array());simulated.erase("held");simulated.erase("offhand");simulated.erase("armor");std::vector<std::pair<std::string,int>> steps;J missing=J::array();std::set<std::string> active;
  auto adjust=[&](const std::string& name,int delta){if(delta<0){int need=-delta;for(auto& stack:simulated["items"])if(mc::name(stack)==name&&need>0){int take=std::min(need,stack.value("count",1));stack["count"]=stack.value("count",1)-take;need-=take;}simulated["items"].erase(std::remove_if(simulated["items"].begin(),simulated["items"].end(),[](const J& s){return s.value("count",0)<=0;}),simulated["items"].end());}else{while(delta>0){int stack=std::min(delta,64);simulated["items"].push_back({{"name",name},{"count",stack}});delta-=stack;}}};
  std::function<bool(std::string,int)> plan=[&](std::string product,int wanted){int have=count(simulated,product);if(have>=wanted)return true;int deficit=wanted-have;if(active.count(product)){missing.push_back({{"item",product},{"need",deficit},{"available",have},{"reason","recipe_cycle"}});return false;}active.insert(product);J pre;try{pre=recipes(product,deficit,simulated);}catch(const Failure&e){active.erase(product);missing.push_back({{"item",product},{"need",deficit},{"available",have},{"reason",e.code}});return false;}
    for(auto it=pre["needs"].begin();it!=pre["needs"].end();++it){std::string ingredient=it.key();int required=it.value().get<int>();if(count(simulated,ingredient)<required)plan(ingredient,required);}
    try{pre=recipes(product,deficit,simulated);}catch(const Failure&e){pre={{"missing",J::array({J{{"item",product},{"need",deficit},{"available",count(simulated,product)},{"reason",e.code}}})}};}
    if(!pre.value("missing",J::array()).empty()){for(auto lack:pre["missing"])missing.push_back(lack);active.erase(product);return false;}
    for(auto it=pre["needs"].begin();it!=pre["needs"].end();++it)adjust(it.key(),-it.value().get<int>());adjust(product,pre.value("produced",deficit));steps.push_back({product,deficit});active.erase(product);return true;};
  // requested is an additional quantity. The DAG's internal wanted value is
  // an inventory total; do not subtract owned output a second time here.
  const int targetTotal=count(simulated,item)+requested;
  J originalInventory=simulated,rootRecipe=recipes(item,requested,simulated);bool planned=plan(item,targetTotal);
  if(!planned||!missing.empty()){J preflight={{"item",item},{"requested",requested},{"steps",J::array()},{"missing",missing}};for(auto& step:steps)preflight["steps"].push_back({{"item",step.first},{"count",step.second}});progress("preflight",preflight);throw Failure("missing_ingredients","配方 DAG 从原料到成品仍有缺口；未调用 /craft",preflight);}
  bool tableAvailable=false;if(rootRecipe.value("table",false)){try{facility("crafting_table",J::object());tableAvailable=true;}catch(const Failure&e){if(e.code!="missing_facility")throw;}}
  if(rootRecipe.value("table",false)&&!tableAvailable&&count(originalInventory,"crafting_table")<1){simulated=originalInventory;steps.clear();missing=J::array();active.clear();planned=plan("crafting_table",1)&&plan(item,targetTotal);}
  J preflight={{"item",item},{"requested",requested},{"steps",J::array()},{"missing",missing}};for(auto& step:steps)preflight["steps"].push_back({{"item",step.first},{"count",step.second}});progress("preflight",preflight);
  if(!planned||!missing.empty())throw Failure("missing_ingredients","配方 DAG 从原料到成品仍有缺口；未调用 /craft",preflight);
  const bool stationAvailable=tableAvailable;
  auto craftSingle=[&](const std::string& product,int amount){auto beforeInv=inventory();auto single=recipes(product,amount,beforeInv);if(!single["missing"].empty())throw Failure("missing_ingredients","合成依赖的材料已变化，未调用 /craft",single);if(single.value("table",false)){J targetTable=J::object();if(!table.is_null())targetTable["target"]=table;try{facility("crafting_table",targetTable);}catch(const Failure&e){if(e.code!="missing_facility")throw;
      if(count(inventory(),"crafting_table")<1)craft("crafting_table",1);P feet=point(status()["pos"]);std::vector<P> spots;for(int dy:{0,1,-1})for(int radius=1;radius<=4;radius++)for(auto d:dirs)spots.push_back(add(feet,{d[0]*radius,dy,d[2]*radius}));std::stable_sort(spots.begin(),spots.end(),[&](P a,P b){auto score=[&](P q){return std::abs(q[1]-feet[1])*3+distance(feet,q);};return score(a)<score(b);});bool placed=false;
      for(P q:spots){if(q==feet||q==add(feet,{0,1,0}))continue;P floor=add(q,{0,-1,0});if(!support(block(floor,true)))continue;auto cell=block(q,true);if(!air(cell)){if(protectedAt(q)||!terrain(cell)||important(cell)||!cell.value("diggable",true))continue;try{tool(false,name(cell));dig(q,true);}catch(const Failure&failure){if(failure.code=="dead"||failure.code=="survival_priority")throw;continue;}if(!air(block(q,true)))continue;}try{place(q,"crafting_table");state["temporaryWorkbench"]={{"pos",jp(q)},{"dimension",dimension}};save();placed=true;break;}catch(const Failure&failure){if(failure.code=="dead"||failure.code=="survival_priority")throw;}}
      if(!placed)throw Failure("temporary_workbench_unavailable","附近没有可见且有支撑面的工作台位置；未调用目标合成");}}
    int before=count(inventory(),product);J result=api("craft",{{"item",product},{"count",amount}});int gained=count(inventory(),product)-before;if(gained<amount)throw Failure("craft_incomplete","合成未达到请求数量",{{"item",product},{"gained",gained},{"requested",amount},{"result",result}});return gained;};
  J crafted=J::array();for(auto& step:steps){if(step.first=="crafting_table"&&stationAvailable)continue;craftSingle(step.first,step.second);crafted.push_back({{"item",step.first},{"count",step.second}});}if(reclaim)reclaimWorkbench();return {{"crafted",item},{"requested",requested},{"steps",crafted},{"preflight",preflight}};
}
J Engine::workshop(const J& p){
  // Models often reuse the craft batch envelope for smelting. Normalize it
  // locally instead of abandoning the furnace and rebuilding a work area.
  if(p.value("mode",std::string("craft"))=="smelt"&&!p.contains("item")&&p.contains("items")){
    auto jobs=p["items"];if(!jobs.is_array()||jobs.empty()||jobs.size()>24)throw Failure("bad_args","熔炼批次需含1到24个原料条目");
    J results=J::array();for(auto job:jobs){if(!job.is_object()||!job.contains("item")||!job["item"].is_string())throw Failure("bad_args","熔炼条目需明确item");J normalized=p;normalized.erase("items");normalized["item"]=job["item"];normalized["count"]=job.value("count",1);if(job.contains("fuel"))normalized["fuel"]=job["fuel"];results.push_back(workshop(normalized));}return results;
  }
  std::string mode=p.value("mode",std::string("craft"));if(mode=="craft"){
    J results=J::array();auto jobs=p.value("items",J::array());if(jobs.empty()&&p.contains("item"))jobs.push_back({{"item",p["item"]},{"count",p.value("count",1)}});if(jobs.empty()||jobs.size()>24)throw Failure("bad_args","合成需要1到24个产物条目");
    for(auto task:jobs){std::string item=task.at("item");int wanted=task.value("count",1);if(task.value("total",false)){auto owned=inventory();wanted-=count(owned,item);if(owned.contains("armor")&&owned["armor"].is_object())for(const auto& piece:owned["armor"])if(piece.is_object()&&name(piece)==item)wanted-=piece.value("count",1);}if(wanted>0)results.push_back(craft(item,wanted,p.value("table",J()),false));}reclaimWorkbench();return results;
  }
  if(mode!="smelt"&&mode!="store"&&mode!="take")throw Failure("bad_args","工作区模式仅 craft/smelt/store/take");
  static const std::map<std::string,std::string> smelting={{"raw_iron","iron_ingot"},{"raw_gold","gold_ingot"},{"raw_copper","copper_ingot"},{"iron_ore","iron_ingot"},{"deepslate_iron_ore","iron_ingot"},{"gold_ore","gold_ingot"},{"deepslate_gold_ore","gold_ingot"},{"copper_ore","copper_ingot"},{"deepslate_copper_ore","copper_ingot"},{"sand","glass"},{"cobblestone","stone"},{"beef","cooked_beef"},{"porkchop","cooked_porkchop"},{"chicken","cooked_chicken"},{"potato","baked_potato"},{"mutton","cooked_mutton"},{"cod","cooked_cod"},{"salmon","cooked_salmon"}};
  std::string input=p.value("item",std::string()),output;std::vector<std::string> inputs;int n=p.value("count",1);
  if(mode=="smelt"){
    if(n<1||n>64)throw Failure("bad_args","单炉数量1到64");
    if(smelting.count(input))output=smelting.at(input);
    else if(ends(input,"_log"))output="charcoal";
    else {
      output=input;
      for(auto [source,product]:smelting)if(product==output)inputs.push_back(source);
      if(output=="charcoal")for(auto wood:{"oak","spruce","birch","jungle","acacia","dark_oak","mangrove","cherry","pale_oak"})inputs.push_back(std::string(wood)+"_log");
      if(inputs.empty())throw Failure("unsupported_recipe","没有已核实的熔炼配方");
    }
  }
  std::string kind=mode=="smelt"?"furnace":"chest";
  if(mode=="take"&&p.contains("target"))kind="";
  J facilityParams=p;
  if(mode=="store"){
    auto now=status();
    if(!facilityParams.contains("target")){
      P nearest{};double best=1e100;bool found=false;
      for(const auto& area:state["workareas"]){if(area.value("dimension",std::string())!=dimension||!area.value("facilities",J::object()).contains("chest"))continue;P q=point(area["facilities"]["chest"]);double dist=distance(point(now["pos"]),q);if(dist<best){best=dist;nearest=q;found=true;}}
      if(!found)throw Failure("missing_facility","存储需要明确指定的已有箱子或已记录据点箱子；不会在途中造箱",{{"storagePolicy","explicit_or_base_only"}});
      facilityParams["target"]=jp(nearest);
    }
  }
  P pos=facility(kind,facilityParams);if(kind.empty())kind=name(block(pos,true));J target={{"pos",jp(pos)}};auto view=api("windowView",{{"target",target}});auto sections=view.value("sections",J::object());
  auto sectionCount=[&](const J& source,std::string section,std::string item){int n=0;for(auto a:source.value("sections",J::object()).value(section,J::array()))if(name(a)==item)n+=a.value("count",1);return n;};
  if(mode=="store"||mode=="take"){
    auto items=p.value("items",J::array());if(items.empty()||items.size()>24)throw Failure("bad_args","存取需明确物品及数量");auto before=inventory();J ops=J::array();std::map<std::string,int> required;
    std::string section=kind=="furnace"?p.value("from",std::string("output")):"container";
    if(kind=="furnace"&&!std::set<std::string>{"input","fuel","output"}.count(section))throw Failure("bad_args","熔炉取物区域仅 input/fuel/output");
    for(auto t:items){std::string item=t.at("item");int n=t.value("count",1);if(n<1||n>256)throw Failure("bad_args","存取数量不符");required[item]+=n;ops.push_back(mode=="store"?J{{"op","put"},{"to","container"},{"item",item},{"count",n}}:J{{"op","take"},{"from",section},{"item",item},{"count",n}});}
    for(auto [item,n]:required){int have=mode=="store"?count(before,item):sectionCount(view,section,item);if(have<n)throw Failure("missing_item","存取前实际物品不足",{{"item",item},{"need",n},{"available",have}});}
    auto result=api("windowAct",{{"target",target},{"ops",ops}});auto after=inventory();for(auto [item,n]:required){int delta=count(after,item)-count(before,item);if(delta!=(mode=="store"?-n:n))throw Failure("transfer_incomplete","窗口转移后背包数量不符",{{"item",item},{"delta",delta},{"requested",n},{"result",result}});}return result;
  }
  if(mode!="smelt")throw Failure("bad_args","工作区模式仅 craft/smelt/store/take");
  auto inv=inventory();int before=count(inv,output);
  auto& batch=state["smeltBatches"][dimension+":"+jp(pos).dump()];
  if(!inputs.empty()){
    auto pending=batch.is_object()?batch.value("input",std::string()):std::string();
    if(batch.is_object()&&!batch.value("complete",true)&&batch.value("requested",0)==n&&std::find(inputs.begin(),inputs.end(),pending)!=inputs.end())input=pending;
    else {
      input=inputs.front();int best=-1;
      for(auto source:inputs){int available=count(inv,source)+sectionCount(view,"input",source);if(available>best){best=available;input=source;}}
    }
    progress("smelt_recipe",{{"requestedItem",p["item"]},{"input",input},{"output",output},{"count",n}});
  }
  bool resume=batch.is_object()&&!batch.value("complete",true)&&batch.value("input",std::string())==input&&batch.value("requested",0)==n;
  int targetOutput=resume?batch.value("targetOutput",before+n):before+n;
  batch={{"input",input},{"output",output},{"requested",n},{"targetOutput",targetOutput},{"complete",false},{"pos",jp(pos)}};save();
  auto takeSection=[&](std::string section,std::string item,int amount){if(item.empty()||amount<1)return;int previous=count(inventory(),item);api("windowAct",{{"target",target},{"ops",J::array({J{{"op","take"},{"from",section},{"item",item},{"count",amount}}})}});if(count(inventory(),item)-previous<amount)throw Failure("transfer_incomplete","熔炉清理物品未完整入包",{{"item",item},{"section",section}});};
  // Old products and incompatible input are local maintenance, not a reason
  // for Distribution to build another furnace or replay the whole task.
  for(auto a:sections.value("output",J::array()))takeSection("output",name(a),a.value("count",0));
  for(auto a:sections.value("input",J::array()))if(!name(a).empty()&&name(a)!=input)takeSection("input",name(a),a.value("count",0));
  view=api("windowView",{{"target",target}});
  // A batch can finish during the window close/open round trip.
  for(auto a:view.value("sections",J::object()).value("output",J::array()))takeSection("output",name(a),a.value("count",0));
  inv=inventory();
  int remaining=std::max(0,targetOutput-count(inv,output));
  if(!remaining){batch["complete"]=true;save();return {{"smelted",output},{"received",count(inv,output)-before},{"resumed",resume}};}
  int existing=sectionCount(view,"input",input),loadN=std::max(0,remaining-existing);
  if(count(inv,input)<loadN)throw Failure("missing_ingredients","入炉前原料不足",{{"item",input},{"need",loadN},{"available",count(inv,input)},{"alreadyLoaded",existing}});
  auto burnTicks=[](const std::string& item){if(item=="coal"||item=="charcoal")return 1600;if(item=="coal_block")return 16000;if(item=="stick")return 100;if(ends(item,"_log")||ends(item,"_wood")||ends(item,"_planks"))return 300;return 0;};
  std::string fuel=p.value("fuel",std::string());
  auto fuelNeeded=[&](std::string candidate){int ticks=burnTicks(candidate);if(!ticks)return 100000;int stocked=sectionCount(view,"fuel",candidate)*ticks;
    // Burning time remains valid when the last fuel item has already vanished.
    if(view.value("info",J::object()).value("burning",false))stocked+=int(view.value("info",J::object()).value("fuel_left",0.0)*ticks);
    return std::max(0,(remaining*200-stocked+ticks-1)/ticks);};
  auto fuelAvailable=[&](std::string candidate){return count(inv,candidate)-(candidate==input?loadN:0);};
  if(fuel.empty()){
    for(auto a:view.value("sections",J::object()).value("fuel",J::array()))if(burnTicks(name(a))&&fuelAvailable(name(a))>=fuelNeeded(name(a)))fuel=name(a);
    std::vector<std::string> fuels={"coal","charcoal","coal_block"};for(auto a:inv.value("items",J::array()))if(burnTicks(name(a)))fuels.push_back(name(a));
    for(auto candidate:fuels)if(fuel.empty()&&fuelAvailable(candidate)>=fuelNeeded(candidate))fuel=candidate;
  }
  if(!burnTicks(fuel))throw Failure("missing_fuel","需煤、木炭、原木、木板或木棍作为燃料；木头也可烧出首批木炭");
  for(auto a:view.value("sections",J::object()).value("fuel",J::array()))if(!name(a).empty()&&name(a)!=fuel)takeSection("fuel",name(a),a.value("count",0));
  inv=inventory();int fuelN=fuelNeeded(fuel);if(fuelAvailable(fuel)<fuelN)throw Failure("missing_fuel","入炉前燃料不足",{{"fuel",fuel},{"need",fuelN},{"available",fuelAvailable(fuel)}});
  J ops=J::array();if(loadN)ops.push_back({{"op","put"},{"item",input},{"count",loadN},{"to","input"}});if(fuelN)ops.push_back({{"op","put"},{"item",fuel},{"count",fuelN},{"to","fuel"}});if(!ops.empty())api("windowAct",{{"target",target},{"ops",ops}});
  while(true){status();auto now=api("windowView",{{"target",target}});int ready=sectionCount(now,"output",output);if(ready)takeSection("output",output,ready);
    remaining=std::max(0,targetOutput-count(inventory(),output));batch["remaining"]=remaining;save();if(!remaining)break;
    int loaded=sectionCount(now,"input",input);if(loaded<remaining)throw Failure("transfer_incomplete","熔炉剩余原料少于尚未完成的批次，保留现场",{{"loaded",loaded},{"remaining",remaining},{"window",now}});
    bool burning=now.value("info",J::object()).value("burning",false);int stocked=sectionCount(now,"fuel",fuel);
    if(!burning&&!stocked)throw Failure("missing_fuel","熔炼中燃料耗尽，已记录批次，重新补燃料后续烧");
    // Reopening a furnace may expose the same rounded progress twice. A
    // burning furnace is still working; do not turn normal ticks into errors.
    progress("smelt",{{"completed",n-remaining},{"total",n},{"remainingMs",remaining*10000},{"pos",jp(pos)}});std::this_thread::sleep_for(std::chrono::seconds(2));
  }
  batch["complete"]=true;save();return {{"smelted",output},{"received",count(inventory(),output)-before},{"resumed",resume},{"pos",jp(pos)}};
}
}
