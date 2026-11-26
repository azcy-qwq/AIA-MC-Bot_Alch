#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <vector>

// Dependency-free high-performance planner. Input: x y z block_name diggable.
// Output: dig x y z / place x y z block_name.
struct Block { int x, y, z; std::string name; bool diggable; };

int argInt(int argc, char** argv, const std::string& key, int fallback) {
  for (int i = 1; i + 1 < argc; ++i) if (argv[i] == key) return std::atoi(argv[i + 1]);
  return fallback;
}

std::string argString(int argc, char** argv, const std::string& key, const std::string& fallback) {
  for (int i = 1; i + 1 < argc; ++i) if (argv[i] == key) return argv[i + 1];
  return fallback;
}

int main(int argc, char** argv) {
  const int targetY = argInt(argc, argv, "--target-y", 0);
  const std::string placeItem = argString(argc, argv, "--place-item", "cobblestone");
  const std::unordered_set<std::string> protectedBlocks = {"bedrock", "barrier", "lava", "flowing_lava", "water", "flowing_water", "bubble_column"};
  std::vector<Block> blocks;
  int x = 0, y = 0, z = 0, diggable = 0;
  std::string name;
  while (std::cin >> x >> y >> z >> name >> diggable) blocks.push_back({x, y, z, name, diggable != 0});
  std::sort(blocks.begin(), blocks.end(), [](const Block& a, const Block& b) {
    if (a.y != b.y) return a.y > b.y;
    if (a.x != b.x) return a.x < b.x;
    return a.z < b.z;
  });
  const auto key = [](int px, int py, int pz) { return std::to_string(px) + "," + std::to_string(py) + "," + std::to_string(pz); };
  std::unordered_set<std::string> occupied;
  std::unordered_map<std::string, std::string> byPosition;
  for (const auto& block : blocks) {
    byPosition[key(block.x, block.y, block.z)] = block.name;
    if (block.y > targetY && block.diggable && block.name != "air" && block.name != "cave_air" && block.name != "void_air" && !protectedBlocks.count(block.name)) std::cout << "dig " << block.x << ' ' << block.y << ' ' << block.z << '\n';
    if (block.y == targetY && block.name != "air" && block.name != "cave_air" && block.name != "void_air") occupied.insert(key(block.x, block.y, block.z));
  }
  for (const auto& block : blocks) {
    const auto support = byPosition.find(key(block.x, targetY - 1, block.z));
    const bool supportSolid = support != byPosition.end() && support->second != "air" && support->second != "cave_air" && support->second != "void_air" && support->second != "lava" && support->second != "water";
    if (block.y == targetY && (block.name == "air" || block.name == "cave_air" || block.name == "void_air") && supportSolid && !occupied.count(key(block.x, block.y, block.z))) std::cout << "place " << block.x << ' ' << block.y << ' ' << block.z << ' ' << placeItem << '\n';
  }
  return 0;
}
