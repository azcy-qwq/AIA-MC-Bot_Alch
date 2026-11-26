#include "engine.hpp"
namespace mc {
J Engine::gatherSurface(const J& goals,J& survey){
  auto currentInventory=inventory();
  auto needed=[&](std::string item){bool capacity=currentInventory.value("empty_slots",36)>0;for(const auto& stack:currentInventory.value("items",J::array()))if(name(stack)==item&&stack.value("count",64)<64)capacity=true;for(const auto& g:goals)if(g.value("item",std::string())==item&&count(currentInventory,item)<g.value("count",1)&&capacity)return true;return false;};
  auto localFailure=[](const Failure&e){return std::set<std::string>{"path_not_found","navigation_failed","unreachable","no_path","stalled","unsafe_navigation","unsafe_excavation","falling_block_risk","out_of_reach","out_of_range","not_visible","no_line_of_sight","dig_unconfirmed","dig_not_applied","no_progress","no_such_entity"}.count(e.code)>0;};
  auto& records=survey["resourceTargets"];if(!records.is_object())records=J::object();
  P origin=point(status()["pos"]);int cut=0,hunted=0;
  // Inventory targets are outputs. Block queries contain plants; entity
  // queries contain animals, never the name of a dropped material.
  if(needed("sugar_cane")){
    auto found=api("findBlocks",{{"types",J::array({"sugar_cane"})},{"radius",16},{"limit",128}}).value("blocks",J::array());
    if(!found.is_array())throw Failure("protocol_error","甘蔗定向检索必须返回坐标列表");
    std::map<std::pair<int,int>,P> columns;for(const auto& b:found)if(b.contains("pos")){P q=point(b["pos"]);auto key=std::make_pair(q[0],q[2]);if(!columns.count(key)||q[1]<columns[key][1])columns[key]=q;}
    std::vector<P> positions;for(const auto& column:columns)positions.push_back(column.second);
    std::stable_sort(positions.begin(),positions.end(),[&](P a,P b){return distance(a,origin)<distance(b,origin);});
    std::set<P> stalks;
    progress("surface_resource_scan",{{"resource","sugar_cane"},{"found",positions.size()},{"pos",jp(origin)}});
    for(P q:positions){
      if(!needed("sugar_cane"))break;
      if(name(block(q,true))!="sugar_cane")continue;
      // Collapse all returned segments to the lowest known plant. Leave the
      // actual root untouched; one cut above it harvests the upper column.
      P root=q;for(int n=0;n<16&&name(block(add(root,{0,-1,0}),true))=="sugar_cane";n++)root=add(root,{0,-1,0});
      if(!stalks.insert(root).second)continue;
      P harvest=add(root,{0,1,0});auto& record=records[jp(root).dump()];
      record={{"resource","sugar_cane"},{"root",jp(root)},{"target",jp(harvest)},{"observedAt",wallms()}};
      if(name(block(harvest,true))!="sugar_cane"){record["status"]="growing";continue;}
      if(protectedAt(harvest)){record["status"]="protected";continue;}
      record["status"]="pending";save();
      try{
        approach(harvest);int before=count(currentInventory,"sugar_cane");
        auto cutPlant=[&](){
          if(name(block(harvest,true))!="sugar_cane")return;
          if(name(block(add(harvest,{0,-1,0}),true))!="sugar_cane")throw Failure("unsafe_excavation","甘蔗根部已变化，不挖根");
          // Removing a non-solid plant cannot open a fluid-retaining wall.
          // Do not apply the solid-mining adjacent-liquid veto to crops.
          api("dig",{{"pos",jp(harvest)},{"collect",false}});
          if(name(block(harvest,true))=="sugar_cane")throw Failure("dig_not_applied","甘蔗未确认采下");
        };
        try{cutPlant();}catch(const Failure&e){
          if(!std::set<std::string>{"not_visible","no_line_of_sight","out_of_reach","out_of_range"}.count(e.code))throw;
          bool changed=false;P from=point(status()["pos"]);
          for(P d:dirs){P side=add(root,d);side[1]=from[1];if(side==from||distance(from,side)>9||!stand(side))continue;
            try{navigate(side,false);cutPlant();changed=true;break;}catch(const Failure& next){if(!localFailure(next))throw;}
          }
          if(!changed)throw;
        }
        cut++;record["status"]="harvested";record["harvestedAt"]=wallms();
        collectDrops({{"types",J::array({"sugar_cane"})},{"radius",6}});
        currentInventory=inventory();record["inventoryGain"]=count(currentInventory,"sugar_cane")-before;save();
        progress("surface_cane_harvested",{{"root",jp(root)},{"target",jp(harvest)},{"gained",record["inventoryGain"]},{"pos",status()["pos"]}});
      }catch(const Failure&e){if(!localFailure(e))throw;record["status"]="deferred";record["error"]=e.code;record["attemptedFrom"]=status()["pos"];save();progress("surface_resource_deferred",record);}
    }
  }
  if(needed("leather")){
    const J types=J::array({"cow","mooshroom","horse","donkey","mule"});
    auto entities=api("getEntities",{{"radius",16},{"types",types}}).value("entities",J::array());
    if(!entities.is_array())throw Failure("protocol_error","皮革来源检索必须返回动物列表");
    P feet=point(status()["pos"]);std::vector<J> animals;
    for(auto e:entities)if(leatherAnimal(e)&&e.contains("pos")&&e.value("visible",true)&&e.value("line_of_sight",true)&&std::abs(point(e["pos"])[1]-feet[1])<=2)animals.push_back(e);
    std::stable_sort(animals.begin(),animals.end(),[&](const J&a,const J&b){return distance(feet,point(a["pos"]))<distance(feet,point(b["pos"]));});
    progress("surface_resource_scan",{{"resource","leather"},{"entityTypes",types},{"found",animals.size()},{"pos",jp(feet)}});
    for(auto e:animals){
      if(!needed("leather"))break;
      int before=count(currentInventory,"leather");
      try{status();approach(point(e["pos"]));auto result=combat({{"entity_id",e.value("id",-1)},{"hunt",true}});hunted++;
        collectDrops({{"types",J::array({"leather","beef"})},{"radius",6}});
        currentInventory=inventory();survey["lastHunt"]={{"entityId",e.value("id",-1)},{"name",name(e)},{"at",wallms()},{"result",result},{"leatherGained",count(currentInventory,"leather")-before}};save();progress("surface_animal_hunted",survey["lastHunt"]);
      }catch(const Failure&ex){if(!localFailure(ex))throw;progress("surface_animal_deferred",{{"entityId",e.value("id",-1)},{"name",name(e)},{"code",ex.code}});}
    }
  }
  return {{"harvested",cut},{"animalsAttempted",hunted},{"pos",status()["pos"]}};
}
}
