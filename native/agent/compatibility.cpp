#include "engine.hpp"
namespace mc {
static bool enchantedItem(const J& item){return item.is_object()&&item.contains("enchantments")&&!item["enchantments"].is_null()&&!item["enchantments"].empty();}

// Public container operations only. Never drop gear or move weapons off-hand.
void Engine::recoverDigCompatibility(){
  auto s=status();P feet=point(s["pos"]);auto inv=inventory();J stored=J::array();std::map<std::string,int> affected;
  for(const auto& item:inv.value("items",J::array()))if(enchantedItem(item))affected[name(item)]+=item.value("count",1);
  if(affected.empty())throw Failure("no_safe_workaround","背包未发现可暂存的附魔物品，不能假称切换装备会修复接口");
  bool hasPlainPick=false;for(const auto& item:inv.value("items",J::array()))if(ends(name(item),"_pickaxe")&&!enchantedItem(item))hasPlainPick=true;
  // Check replacement materials before moving any valuable equipment.
  if(!hasPlainPick){auto pre=recipes("stone_pickaxe",1,inv);if(!pre["missing"].empty())throw Failure("missing_ingredients","没有普通镐且缺少替换石镐原料，保留装备不做转移",pre);}
  std::vector<P> candidates;auto found=api("findBlocks",{{"types",J::array({"chest"})},{"radius",4},{"limit",8}});
  for(const auto& value:found.value("blocks",J::array()))if(value.contains("pos")&&distance(feet,point(value["pos"]))<=3)candidates.push_back(point(value["pos"]));
  P chest{};bool usable=false;
  auto roomFor=[&](P q){auto view=api("windowView",{{"target",{{"pos",jp(q)}}}});int occupied=0;for(const auto& item:view.value("sections",J::object()).value("container",J::array()))if(item.is_object()&&!name(item).empty())occupied++;return 27-occupied>=int(affected.size());};
  for(P q:candidates){if(name(block(q,true))!="chest"||!air(block(add(q,{0,1,0}),true)))continue;try{if(roomFor(q)){chest=q;usable=true;break;}}catch(const Failure&e){if(e.code=="dead"||e.code=="survival_priority")throw;}}
  if(!usable){
    if(count(inv,"chest")<1)throw Failure("missing_facility","没有三格内可达箱子或可放置的备用箱子，附魔装备未移动");
    // Prefer an alcove diagonal to the bot, leaving the main route open.
    std::vector<P> spots;for(int dx:{-1,1})for(int dz:{-1,1})spots.push_back(add(feet,{dx,0,dz}));for(P d:dirs)spots.push_back(add(feet,{d[0]*2,0,d[2]*2}));
    for(P q:spots){if(protectedAt(q))continue;observe({q,add(q,{0,1,0}),add(q,{0,-1,0})},true);if(!air(block(q))||!air(block(add(q,{0,1,0})))||!support(block(add(q,{0,-1,0}))))continue;try{place(q,"chest");chest=q;usable=roomFor(q);if(usable)break;}catch(const Failure&e){if(e.code=="dead"||e.code=="survival_priority")throw;}if(name(block(q,true))=="chest")break;}
  }
  if(!usable)throw Failure("missing_facility","附近没有无需开挖即可安全放置并打开的箱子，附魔装备未移动");
  state["apiCompatibility"]["enchantments"]={{"status","storing"},{"pos",jp(chest)},{"dimension",dimension},{"items",J::array()},{"at",wallms()}};
  state["anchors"]["附魔装备暂存箱"]={{"pos",jp(chest)},{"dimension",dimension},{"verifiedAt",wallms()}};save();
  for(const auto& [item,amount]:affected){
    // enchanted:true selects that exact class instead of stashing the plain spare.
    api("windowAct",{{"target",{{"pos",jp(chest)}}},{"ops",J::array({J{{"op","put"},{"to","container"},{"item",item},{"count",amount},{"enchanted",true}}})}});
    auto after=inventory();int stillHeld=0;for(const auto& value:after.value("items",J::array()))if(name(value)==item&&enchantedItem(value))stillHeld+=value.value("count",1);
    auto view=api("windowView",{{"target",{{"pos",jp(chest)}}}});int confirmed=0;for(const auto& value:view.value("sections",J::object()).value("container",J::array()))if(name(value)==item&&enchantedItem(value))confirmed+=value.value("count",1);
    if(stillHeld>0||confirmed<amount)throw Failure("transfer_unconfirmed","附魔装备暂存未获背包与箱子双重确认，停止兼容重试",{{"item",item},{"pos",jp(chest)}});
    stored.push_back({{"item",item},{"count",amount}});state["apiCompatibility"]["enchantments"]["items"]=stored;save();
  }
  if(!hasPlainPick){auto result=craft("stone_pickaxe",1);progress("api_compatibility_tool",{{"result",result}});}
  tool(false,"stone");state["apiCompatibility"]["enchantments"]["status"]="using_plain_tool";save();
}
}
