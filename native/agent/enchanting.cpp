#include "engine.hpp"
namespace mc {
static bool enchanted(const J& item){return item.is_object()&&item.contains("enchantments")&&!item["enchantments"].empty();}
J Engine::enchanting(const J& p){
  auto s=status();auto inv=inventory();P feet=point(s["pos"]);
  if(dimension!="overworld")throw Failure("unsafe_navigation","本轮附魔仅在主世界进行");
  const long long started=wallms();
  const bool optional=p.value("optional",true);
  const long long maxRuntime=std::clamp<long long>(p.value("maxRuntimeMs",180000LL),10000LL,900000LL);
  auto optionalStop=[&](const J& completed,const std::string& code="enchanting_optional_stopped"){
    if(!optional||wallms()-started<maxRuntime)return false;
    progress("enchanting_optional_stop",{{"code",code},{"elapsedMs",wallms()-started},{"completed",completed},{"message","附魔属于可选分支，达到运行上限后保留已完成部分并结束"}});
    return true;
  };
  if(p.value("mode",std::string())=="build"){
    const int shelves=std::clamp(p.value("bookshelves",15),0,15);
    auto& job=state["enchantingArea"];if(!job.is_object())job=J::object();
    P center=p.contains("center")?point(p["center"]):job.contains("center")?point(job["center"]):add(feet,{3,0,0});
    bool existingTable=false;
    if(!p.contains("center")&&!job.contains("center")){
      auto found=api("findBlocks",{{"types",J::array({"enchanting_table"})},{"radius",32},{"limit",8}});
      for(const auto& b:found.value("blocks",J::array()))if(b.contains("pos")){center=point(b["pos"]);existingTable=true;break;}
    }
    if(existingTable){
      job["center"]=jp(center);job["dimension"]=dimension;job["status"]="existing";job["verifiedAt"]=wallms();
      auto shelvesFound=api("findBlocks",{{"types",J::array({"bookshelf"})},{"radius",12},{"limit",64}});
      int visibleShelves=static_cast<int>(shelvesFound.value("blocks",J::array()).size());
      job["bookshelves"]=visibleShelves;save();
      progress("enchanting_existing_facility",{{"center",jp(center)},{"bookshelves",visibleShelves},{"message","复用附近已存在的附魔台和书架，不强制建新房间"}});
      return {{"center",jp(center)},{"bookshelves",visibleShelves},{"verified",true},{"reused",true}};
    }
    if(distance(center,feet)>24){navigate(center,false);feet=point(status()["pos"]);}
    // Select a room before consuming materials. Existing facilities are never
    // displaced, and liquid/unknown/protected cells reject this site.
    std::vector<P> volume;for(int x=-2;x<=2;x++)for(int z=-2;z<=2;z++)for(int y=-1;y<=1;y++)volume.push_back(add(center,{x,y,z}));observe(volume,true);
    for(P q:volume){auto b=block(q);bool fixture=name(b)=="bookshelf"||name(b)=="enchanting_table";
      if(liquid(b)||name(b).empty()||name(b)=="void_air"||(important(b)&&!fixture)||(!air(b)&&!terrain(b)&&!fixture)||(q[1]>=center[1]&&!air(b)&&protectedAt(q)&&!fixture))
        throw Failure("enchanting_site_unavailable","附魔区需可安全扩建的5×5两格空间；保留已有设施，请选择相邻岩壁",{{"center",jp(center)},{"blocked",jp(q)},{"block",name(b)}});
      if(q[1]<center[1]&&!support(b))throw Failure("enchanting_site_unavailable","附魔区地板尚无实体支撑，请先补路",{{"pos",jp(q)}});
    }
    int placed=0;for(int x=-2;x<=2;x++)for(int z=-2;z<=2;z++)if(std::max(std::abs(x),std::abs(z))==2&&!(x==0&&z==2)&&name(block(add(center,{x,0,z})))=="bookshelf")placed++;
    if(name(block(center))!="enchanting_table"&&count(inv,"enchanting_table")==0)craft("enchanting_table",1);
    inv=inventory();int deficit=std::max(0,shelves-placed-count(inv,"bookshelf"));if(deficit)craft("bookshelf",deficit);
    job["center"]=jp(center);job["dimension"]=dimension;job["status"]="building";save();
    // Two-block room. Approach each excavation from an actual walking cell;
    // do not demand that a future room is already traversable.
    std::vector<P> columns;for(int x=-2;x<=2;x++)for(int z=-2;z<=2;z++)columns.push_back(add(center,{x,0,z}));
    std::stable_sort(columns.begin(),columns.end(),[&](P a,P b){return distance(a,feet)<distance(b,feet);});
    for(P column:columns)for(int y:{1,0}){P q=add(column,{0,y,0});auto b=block(q,true);if(air(b)||name(b)=="bookshelf"||name(b)=="enchanting_table")continue;
      if(distance(q,point(status()["pos"]))>3.5)approach(q);tool(false,name(b));dig(q,true,false,false);
    }
    if(name(block(center,true))!="enchanting_table"){approach(center);place(center,"enchanting_table");}
    for(int x=-2;x<=2&&placed<shelves;x++)for(int z=-2;z<=2&&placed<shelves;z++)if(std::max(std::abs(x),std::abs(z))==2&&!(x==0&&z==2)){
      if(optionalStop(J::array())){job["status"]="partial";job["bookshelves"]=placed;save();return {{"center",jp(center)},{"bookshelves",placed},{"warning",true},{"code","enchanting_optional_stopped"},{"completed",J::array()}};}
      P q=add(center,{x,0,z});if(name(block(q,true))=="bookshelf")continue;approach(q);place(q,"bookshelf");placed++;job["bookshelves"]=placed;save();
    }
    job["bookshelves"]=placed;job["status"]="ready";job["verifiedAt"]=wallms();state["anchors"]["附魔区"]={{"pos",jp(add(center,{0,0,1}))},{"dimension",dimension}};
    bool marked=false;for(auto a:state["workareas"])if(a.value("name",std::string())=="附魔区"&&a.value("dimension",std::string())==dimension)marked=true;
    if(!marked)state["workareas"].push_back({{"name","附魔区"},{"dimension",dimension},{"min",jp(add(center,{-2,-1,-2}))},{"max",jp(add(center,{2,1,2}))},{"entrance",jp(add(center,{0,0,2}))},{"facilities",{{"enchanting_table",jp(center)}}}});save();
    return {{"center",jp(center)},{"bookshelves",placed},{"verified",true}};
  }
  J target=p;if(!target.contains("target")&&state.value("enchantingArea",J::object()).contains("center"))target["target"]=state["enchantingArea"]["center"];
  P table=facility("enchanting_table",target);J completed=J::array();
  const std::vector<std::pair<std::string,std::string>> order={{"diamond_pickaxe","hand"},{"diamond_sword","hand"},{"diamond_helmet","head"},{"diamond_chestplate","torso"},{"diamond_leggings","legs"},{"diamond_boots","feet"}};
  for(auto [item,slot]:order){
    if(optionalStop(completed))return {{"warning",true},{"code","enchanting_optional_stopped"},{"completed",completed},{"message","保留已完成附魔，放弃剩余可选装备"}};
    inv=inventory();bool done=false;for(auto v:inv.value("items",J::array()))if(v.is_object()&&name(v)==item&&enchanted(v))done=true;for(auto v:inv.value("armor",J::object()))if(v.is_object()&&name(v)==item&&enchanted(v))done=true;
    if(done){completed.push_back({{"item",item},{"alreadyEnchanted",true}});continue;}
    bool worn=false;for(auto v:inv.value("armor",J::object()))if(v.is_object()&&name(v)==item)worn=true;
    if(!worn&&count(inv,item)==0)return {{"warning",true},{"code","missing_item"},{"item",item},{"completed",completed},{"message","按镐→剑→甲顺序附魔，先补足当前物品"}};
    s=status();int minimum=std::clamp(p.value("minLevel",30),1,30);
    if(s.value("xp_level",0)<minimum||count(inv,"lapis_lazuli")<3)return {{"warning",true},{"code","enchanting_supplies_needed"},{"nextItem",item},{"minXpLevel",minimum},{"completed",completed},{"message","保留附魔顺序，先补经验或青金石"}};
    // API windowPut searches backpack slots, not armor slots. Swap in a
    // carried plain replacement, then restore the diamond piece even on error.
    bool swapped=false;if(worn){auto suffix=item.substr(8);std::string replacement;for(auto tier:{"iron_","chainmail_","leather_","golden_"})if(count(inv,std::string(tier)+suffix)>0){replacement=std::string(tier)+suffix;break;}
      if(replacement.empty())return {{"warning",true},{"code","armor_swap_needed"},{"item",item},{"completed",completed},{"message","需要一件背包内替换盔甲把钻甲换回背包；禁止放副手"}};
      equip(replacement,slot);swapped=true;
    }
    try{
      // A single request keeps input, selection and retrieval in one window.
      // Level 30 shelves use option 2; lower tiers explicitly opt into option 0.
      int option=minimum>=30?2:0;
      api("windowAct",{{"target",{{"pos",jp(table)}}},{"ops",J::array({J{{"op","put"},{"to","item"},{"item",item},{"count",1},{"enchanted",false}},J{{"op","put"},{"to","lapis"},{"item","lapis_lazuli"},{"count",3}},J{{"op","select"},{"option",option}},J{{"op","take"},{"from","item"}}})}});
      inv=inventory();bool verified=false;for(auto v:inv.value("items",J::array()))if(v.is_object()&&name(v)==item&&enchanted(v))verified=true;
      if(!verified)throw Failure("enchanting_unconfirmed","窗口已返回但背包尚未确认附魔；不盲目重复消耗经验",{{"item",item}});
      if(swapped)equip(item,slot);else if(slot=="hand")equip(item);
      state["enchantingProgress"][item]={{"verifiedAt",wallms()},{"table",jp(table)}};save();completed.push_back({{"item",item},{"verified",true}});progress("enchant_equipment",{{"completed",completed},{"nextOrder","镐→剑→甲"}});
    }catch(...){if(swapped){try{equip(item,slot);}catch(...){}}throw;}
  }
  return {{"completed",completed},{"verified",true}};
}
}
