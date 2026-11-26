#include "engine.hpp"
#include <set>
#include <deque>
static bool recoverableWarning(const std::string& code){
  static const std::set<std::string> codes={"path_not_found","navigation_failed","unreachable","no_path","stalled","open_space_ahead","resource_unavailable","missing_ingredients","missing_item","missing_tool","missing_facility","missing_fuel","workarea_not_underground","unsafe_workarea","workarea_site_unavailable","workarea_site_unreachable","workarea_materials_missing","workarea_missing_tool","workarea_incomplete","base_materials_missing","base_incomplete","temporary_workbench_unavailable","unsafe_navigation","wrong_facility","furnace_in_use","no_progress"};
  return codes.count(code)>0||code=="enchanting_site_unavailable"||code=="option_unavailable"||code=="enchanting_unconfirmed";
}
int main(int argc,char**argv){
  using namespace mc;std::string line;
  if(argc>1&&std::string(argv[1])=="--monitor"){
    struct Harm {long long at;double wear;bool lost;};std::deque<Harm> harms;J previous;std::map<int,long long> attackers;long long lastSeq=-1;double peakHealth=20;
    while(std::getline(std::cin,line)){try{
      auto snap=J::parse(line);auto s=snap.value("status",J::object());const auto now=clockms();bool hurt=false,lost=false;double wear=0;
      if(s.is_object()&&!s.value("alive",true)){previous=J();harms.clear();peakHealth=20;}
      if(previous.is_object()&&s.is_object()){
        if(s.value("health",20.0)<previous.value("status",J::object()).value("health",20.0))hurt=true;
        auto oldArmor=previous.value("inventory",J::object()).value("armor",J::object()),armor=snap.value("inventory",J::object()).value("armor",J::object());
        for(auto it=oldArmor.begin();it!=oldArmor.end();++it)if(it.value().is_object()&&armor.contains(it.key())){const auto& item=armor[it.key()];if(item.is_null())lost=true;else if(item.is_object()&&name(item)==name(it.value()))wear=std::max(wear,item.value("durability_used",0.0)-it.value().value("durability_used",0.0));}
      }
      for(auto e:snap.value("events",J::array()))if(e.value("type",std::string())=="hurt"){long long seq=e.value("seq",e.value("t",0LL));if(seq>lastSeq){hurt=true;lastSeq=seq;for(auto key:{"source_entity","likely_attacker"})if(e.contains(key)&&e[key].is_object()&&e[key].contains("id")){attackers[e[key]["id"].get<int>()]=now;break;}}}
      for(auto it=attackers.begin();it!=attackers.end();)if(now-it->second>10000)it=attackers.erase(it);else ++it;
      if(snap.contains("entities"))for(auto& entity:snap["entities"])if(attackers.count(entity.value("id",-1)))entity["confirmed_attacker"]=true;
      if(hurt||wear>0||lost)harms.push_back({now,wear,lost});while(!harms.empty()&&now-harms.front().at>10000)harms.pop_front();
      double totalWear=0;bool lostRecently=false;for(const auto& harm:harms){totalWear+=harm.wear;lostRecently=lostRecently||harm.lost;}peakHealth=std::max(peakHealth,s.value("health",20.0));
      snap["tacticalHistory"]={{"recentHits",harms.size()},{"armorWear",totalWear},{"armorLost",lostRecently},{"peakHealth",peakHealth}};previous=snap;
      std::cout<<assess(snap).dump()<<std::endl;
    }catch(const std::exception&e){std::cout<<J({{"urgent",false},{"error",e.what()}}).dump()<<std::endl;}}return 0;
  }
  try{if(!std::getline(std::cin,line))return 1;auto init=J::parse(line);Engine engine(init);try{auto result=engine.run(init.at("job"),init.value("params",J::object()));engine.progress("finished",{{"remainingMs",0}});std::cout<<J({{"kind","result"},{"result",result},{"state",engine.snapshot()}}).dump()<<std::endl;return 0;}catch(const Failure&e){if(!recoverableWarning(e.code))throw;engine.progress("warning",{{"code",e.code},{"message",e.what()}});std::cout<<J({{"kind","result"},{"result",{{"warning",true},{"code",e.code},{"message",e.what()},{"details",e.details}}},{"state",engine.snapshot()}}).dump()<<std::endl;return 0;}}
  catch(const Failure&e){std::cout<<J({{"kind","error"},{"error",{{"code",e.code},{"message",e.what()},{"details",e.details}}}}).dump()<<std::endl;return 2;}
  catch(const std::exception&e){std::cout<<J({{"kind","error"},{"error",{{"code","native_error"},{"message",e.what()}}}}).dump()<<std::endl;return 3;}
}
