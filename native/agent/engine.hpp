#pragma once
#include "../vendor/json.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
namespace mc {
using J = nlohmann::json;
using P = std::array<int,3>;
struct Failure : std::runtime_error { std::string code; J details; Failure(std::string c,std::string m,J d=J::object()):std::runtime_error(m),code(c),details(d){} };
inline long long clockms(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}
inline long long wallms(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
inline P point(const J& a){if(!a.is_array()||a.size()!=3)throw Failure("bad_args","需要三维坐标 [x,y,z]");P p;for(int i=0;i<3;i++){if(!a[i].is_number()||!std::isfinite(a[i].get<double>()))throw Failure("bad_args","坐标必须是有限数值");p[i]=(int)std::floor(a[i].get<double>());}return p;}
inline J jp(P p){return J::array({p[0],p[1],p[2]});}
inline P add(P p,P v){for(int i=0;i<3;i++)p[i]+=v[i];return p;}
inline double distance(P a,P b){double n=0;for(int i=0;i<3;i++)n+=double(a[i]-b[i])*(a[i]-b[i]);return std::sqrt(n);}
inline std::string name(const J& v){std::string s=v.value("name",std::string());if(s.rfind("minecraft:",0)==0)s=s.substr(10);return s;}
inline bool healingDeferred(const J& status,const J& combat){
  const auto& deferred=combat.value("healingDeferred",J::object());
  return !deferred.empty()&&deferred.value("dimension",std::string())==status.value("dimension",std::string("overworld"))
    &&status.value("health",0.0)>=deferred.value("health",20.0)
    &&status.value("food",20)<=deferred.value("food",0);
}
inline bool ends(std::string a,std::string b){return a.size()>=b.size()&&a.compare(a.size()-b.size(),b.size(),b)==0;}
inline bool air(const J& b){return name(b)=="air"||name(b)=="cave_air";}
// Walking clearance is not the same as empty space for placing/digging.
// Non-colliding ground cover must never become a phantom step or support.
inline bool passable(const J& b){static const std::set<std::string> plants={"grass","short_grass","tall_grass","fern","large_fern","torch","wall_torch","dandelion","poppy","wildflowers","leaf_litter","pink_petals","sugar_cane","wheat","carrots","potatoes","beetroots","nether_wart"};return air(b)||plants.count(name(b));}
inline bool leatherAnimal(const J& e){return std::set<std::string>{"cow","mooshroom","horse","donkey","mule"}.count(name(e))&&!e.value("baby",false)&&!e.value("is_baby",false)&&!e.value("tamed",false)&&!e.value("is_tamed",false)&&(!e.contains("age")||!e["age"].is_number()||e["age"].get<double>()>=0)&&(!e.contains("owner")||e["owner"].is_null()||e["owner"]=="")&&(!e.contains("custom_name")||e["custom_name"].is_null()||e["custom_name"]=="");}
inline bool liquid(const J& b){auto n=name(b);return n=="water"||n=="lava"||n=="flowing_water"||n=="flowing_lava"||n=="bubble_column";}
inline bool important(const J& b){auto n=name(b);return n=="bedrock"||n=="barrier"||n=="void_air"||n=="enchanting_table"||n=="bookshelf"||n=="chest"||n=="trapped_chest"||n=="crafting_table"||n=="furnace"||n=="blast_furnace"||n=="smoker"||n=="ender_chest"||ends(n,"_bed")||ends(n,"_shulker_box")||n.find("portal")!=std::string::npos;}
inline bool support(const J& b){auto n=name(b);return !n.empty()&&!passable(b)&&!liquid(b)&&n!="void_air"&&n!="fire"&&n!="soul_fire"&&n!="cobweb"&&n!="ladder"&&n!="vine"&&n!="snow"&&!ends(n,"_sapling")&&!ends(n,"_flower")&&!ends(n,"_carpet")&&!ends(n,"_slab")&&!ends(n,"_stairs")&&!ends(n,"_fence")&&!ends(n,"_wall")&&!ends(n,"_trapdoor");}
inline bool falling(const J& b){return name(b)=="sand"||name(b)=="gravel"||name(b)=="red_sand";}
inline bool terrain(const J& b){static const std::set<std::string>s={"stone","dirt","grass_block","coarse_dirt","rooted_dirt","clay","deepslate","cobblestone","cobbled_deepslate","tuff","granite","diorite","andesite","netherrack","calcite","dripstone_block","smooth_basalt","basalt","blackstone"};return s.count(name(b))||falling(b)||ends(name(b),"_ore");}
inline const std::array<P,4> dirs={P{1,0,0},P{-1,0,0},P{0,0,1},P{0,0,-1}};
inline bool hasIronArmor(const J& inv){
  std::set<std::string> parts;
  auto inspect=[&](const J& item){if(!item.is_object()||item.value("count",1)<1)return;for(auto part:{"helmet","chestplate","leggings","boots"})for(auto tier:{"iron","diamond","netherite"})if(name(item)==std::string(tier)+"_"+part)parts.insert(part);};
  for(const auto& item:inv.value("items",J::array()))inspect(item);
  if(inv.contains("armor")&&inv["armor"].is_object())for(const auto& item:inv["armor"])inspect(item);
  return parts.size()==4;
}
inline double orePriority(P feet,P ore,std::string resource,const J& inv,int xp=30){
  static const std::map<std::string,double> values={{"diamond",120},{"iron",45},{"lapis",35},{"coal",30},{"emerald",25},{"redstone",22},{"gold",18},{"copper",5},{"quartz",12}};
  if(resource.rfind("deepslate_",0)==0)resource=resource.substr(10);if(ends(resource,"_ore"))resource=resource.substr(0,resource.size()-4);
  double value=values.count(resource)?values.at(resource):1;std::string item=resource=="iron"?"raw_iron":resource=="lapis"?"lapis_lazuli":resource;
  int have=0;for(auto s:inv.value("items",J::array()))if(name(s)==item)have+=s.value("count",1);
  int need=resource=="diamond"?4:resource=="lapis"?18:resource=="coal"?16:resource=="iron"?8:0;
  double deficit=need?std::max(0.0,double(need-have)/need):0;
  if(xp<30&&(resource=="coal"||resource=="redstone"||resource=="lapis"||resource=="diamond"))value*=1.35;
  double horizontal=std::hypot(double(ore[0]-feet[0]),double(ore[2]-feet[2]));
  return value*(1+2*deficit)/(1+.16*horizontal+.45*std::abs(ore[1]-feet[1])+.015*std::pow(distance(feet,ore),2));
}

class Engine {
  int sequence=0; std::string stateFile; J state; std::string dimension; std::map<P,J> cache; std::set<P> doorwayRepairs;
  long long began=clockms(); int operations=0; int blocksDug=0; int inventoryCleanupAt=-32, toolMaintenanceAt=-32; std::string lastOp, preferredTool; J lastParams; bool rescue=false; bool digCompatibilityAttempted=false; bool sweepingOres=false;
 public:
  explicit Engine(const J& init);
  J api(const std::string& method,J params=J::object());
  void progress(std::string phase,J extra=J::object());
  J status(bool survival=true); J inventory(); J block(P p,bool fresh=false); void observe(const std::vector<P>& points,bool fresh=false); void invalidate(){cache.clear();}
  void save(); J snapshot(){return state;} bool protectedAt(P p); bool stand(P p); void safeStand(P p);
  int count(const J& inv,const std::string& item); J tidyMiningInventory(J inv); J maintainMiningTools(J inv); std::string filler(); void equip(std::string item,std::string slot="hand");
  void dig(P p,bool collect=true,bool workarea=false,bool sweep=true); void sweepVisibleOres(P around,std::vector<P>* harvested=nullptr); void place(P p,std::string item); P rawMove(P p,bool requireStand=true,std::optional<P> knownOrigin=std::nullopt);
  J breathe();
  J reachShore();
  bool exploringCave=false;
  void exploreMiningCave(P checkpoint,J& detour,std::string source);
  void harvestOre(P p);
  void recoverOreScaffold();
  void illuminate(P feet,P heading=P{0,0,0});
  void navigate(P goal,bool construct=false); std::vector<P> localPath(P start,P goal); bool exposedAhead(P next,P forward); bool recordedPassage(P feet); void corridor(P target,std::string material="",bool allowOpenSpace=true,bool sweep=true); void staircase(bool up,int steps,P direction,std::string material="",bool allowOpenSpace=true); void bridge(P goal,std::string material=""); void pillar(int height,std::string material="");
  void approach(P p,bool localOnly=false); void restoreMiningPosition(P p); void tool(bool wood,std::string resource=""); void deferOre(P p,std::string resource,int requiredTier); void recoverTreePillar();
  J gather(const J& params,bool wood); J harvestTrees(const J& params); J collectDrops(const J& params); J fishbone(const J& params); J buildWorkarea(const J& params); J buildBase(const J& params); J workshop(const J& params); J combat(const J& params); J survive(const J& params); J maintain(const J& params); J recover(const J& params);
  J craft(std::string item,int count,J table=nullptr,bool reclaim=true); void reclaimWorkbench(); J recipes(std::string item,int requested,const J& inv); P facility(std::string kind,const J& params); J route(const J& params); J anchor(const J& params);
  void recoverDigCompatibility();
  P placeFacility(std::string kind,P preferred);
  J explore(const J& params); J enchanting(const J& params);
  J gatherSurface(const J& goals,J& survey);
  J run(std::string job,const J& params);
  void setDeath(const J& death){state["death"]=death;if(state.contains("combat")&&state["combat"].is_object())state["combat"].erase("healingDeferred");save();}
};
J assess(const J& snapshot);
}
