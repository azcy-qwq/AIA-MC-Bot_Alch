# Terrain planner

`terrain_flatten.cpp` is a dependency-free C++17 planner. It receives scanned
blocks and emits candidate `dig` and `place` operations. The runtime performs
the actual public API calls, so the planner cannot bypass the competition API.

Build with `./native/build.ps1` on Windows. Set `TERRAIN_PLANNER_BIN` when the
executable is stored elsewhere.
