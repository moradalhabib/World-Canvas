/* =====================================================================
 *  GOD SIMULATOR — single-file vanilla JS engine
 *  Isometric 24×24 world. Autonomous NPCs. Premium dark UI.
 *  Carries forward: mood / crime / medicine / leisure / dollhouse /
 *  fauna AI on top of the master prompt's vanilla rebuild.
 * ===================================================================== */

(() => {
  "use strict";

  // ================================================================
  //  CONSTANTS
  // ================================================================
  const TILE_W = 128;
  const TILE_H = 64; // strict 2:1
  const GRID_COLS = 24;
  const GRID_ROWS = 24;

  const TICK_MS = 600; // 1 in-game day at x1
  const SEASON_DAYS = 30;
  const SEASONS = ["Spring", "Summer", "Autumn", "Winter"];

  const PALETTE = {
    grass:    "#8aab6e",
    forest:   "#5e7d4a",
    farmland: "#a89360",
    water:    "#6a90a8",
    sand:     "#c9b98a",
    stone:    "#7a7e84",
    road:     "#6b5d48",
    snow:     "#d6dfe8",
  };
  const SHADE = (hex, k) => {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  };

  const ROLE_COLORS = {
    Farmer:     "#7a8a4a",
    Builder:    "#8a6c3e",
    Woodcutter: "#5d6e3a",
    Merchant:   "#9b7848",
    Priest:     "#c0a060",
    Guard:      "#5a6a82",
    Child:      "#bfa680",
  };

  const POWER_COSTS = { bless: 50, strike: 15, rain: 20, grow: 10, birth: 80, plague: 0 };

  const FIRST_NAMES_M = ["Aldric","Bram","Cedric","Dorian","Edmund","Finn","Gideon","Hagen","Ivar","Jorvik","Kael","Lior","Magnus","Niall","Orin","Percival","Quill","Rorik","Soren","Theron","Ulric","Varek","Wren","Xander","Yoren","Zeph"];
  const FIRST_NAMES_F = ["Aelis","Briga","Calla","Darcy","Elara","Fiora","Greta","Hilda","Isolde","Juno","Kaeli","Lyra","Mira","Nyssa","Orla","Petra","Quinn","Rhea","Sable","Tessa","Una","Vesna","Wren","Xara","Ylva","Zara"];
  const SURNAMES = ["Ashford","Blackwood","Crane","Duvalle","Emberly","Fairwynd","Greaves","Hollis","Ironwood","Jansen","Kestrel","Larkspur","Marrow","Northcott","Oakley","Parnell","Quinton","Ravenshaw","Stoneford","Thorne","Ulster","Vance","Whitmore","Yarrow","Zellan"];
  const pickName = (gender) => {
    const first = (gender === "F" ? FIRST_NAMES_F : FIRST_NAMES_M)[Math.floor(Math.random() * 26)];
    const surname = SURNAMES[Math.floor(Math.random() * SURNAMES.length)];
    return `${first} ${surname}`;
  };

  // ================================================================
  //  STATE
  // ================================================================
  const State = {
    tiles: [],          // tiles[r][c] = { type, walkable, foodYield, woodYield, stoneYield }
    citizens: [],
    buildings: [],      // {id, kind, row, col, level, smokePhase, sway}
    graves: [],         // {row, col, addedAt}
    animals: [],        // {id, kind:'sheep', row, col, vrow, vcol, dir, nextWanderAt, sway}
    particles: [],      // smoke, leaves, snow, sparkle, ripple, lightning, dissolve
    resources: { food: 220, wood: 80, stone: 40, gold: 50, faith: 100 },
    time: { day: 1, season: 0, year: 1, paused: false, scale: 1, accum: 0, totalDays: 0 },
    weather: "Clear",   // "Clear" | "Rain" | "Storm"
    weatherUntilDay: 0,
    notifications: [],
    selected: null,     // {kind: "citizen"|"tile", ref}
    activePower: null,
    camera: { x: 0, y: 0 },
    cameraDrag: null,
    shake: { until: 0, mag: 0 },
    extinct: false,
    nextId: 1,
    lastBlessUntil: 0,
    rainBoostUntilDay: 0,
    plagueActive: false,
  };
  const newId = () => State.nextId++;

  // ================================================================
  //  ASSETS
  // ================================================================
  const Assets = {
    images: {},
    ready: false,
    failed: new Set(),
  };
  const ASSET_LIST = [
    { key: "grass",  src: "assets/grass_1.png" },
    { key: "sand",   src: "assets/sand_1.png" },
    { key: "tree",   src: "assets/tree_3.png" },
    { key: "house",  src: "assets/house_4.png" },
  ];
  function loadAssets() {
    const fill = document.getElementById("loading-fill");
    let done = 0;
    const promises = ASSET_LIST.map(({ key, src }) => new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        Assets.images[key] = img;
        done++;
        fill.style.width = `${(done / ASSET_LIST.length) * 100}%`;
        res();
      };
      img.onerror = () => {
        Assets.failed.add(key);
        console.warn(`[Assets] Failed to load ${src} — falling back to procedural shape.`);
        done++;
        fill.style.width = `${(done / ASSET_LIST.length) * 100}%`;
        res();
      };
      img.src = src;
    }));
    return Promise.all(promises).then(() => {
      Assets.ready = true;
    });
  }

  // ================================================================
  //  WORLD GENERATION
  // ================================================================
  function generateWorld() {
    State.tiles = Array.from({ length: GRID_ROWS }, (_, r) =>
      Array.from({ length: GRID_COLS }, (_, c) => ({
        type: "grass",
        walkable: true,
        foodYield: 0,
        woodYield: 0,
        stoneYield: 0,
      }))
    );

    // Lake (cluster) in NE quadrant
    const lakeCx = 5 + Math.floor(Math.random() * 3);
    const lakeCy = 4 + Math.floor(Math.random() * 3);
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      const dx = c - lakeCx, dy = r - lakeCy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 3.2) State.tiles[r][c].type = "water";
      else if (d < 4.0) State.tiles[r][c].type = "sand";
    }

    // Forest patches
    const forestSeeds = 5;
    for (let i = 0; i < forestSeeds; i++) {
      const cx = Math.floor(Math.random() * GRID_COLS);
      const cy = Math.floor(Math.random() * GRID_ROWS);
      const radius = 2 + Math.floor(Math.random() * 3);
      for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
        const t = State.tiles[r][c];
        if (t.type !== "grass") continue;
        const dx = c - cx, dy = r - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius && Math.random() > d / (radius + 1)) {
          t.type = "forest";
          t.woodYield = 4 + Math.floor(Math.random() * 4);
        }
      }
    }

    // Stone quarry tiles (2-3 patches)
    for (let i = 0; i < 3; i++) {
      const cx = Math.floor(Math.random() * GRID_COLS);
      const cy = Math.floor(Math.random() * GRID_ROWS);
      for (let r = cy - 1; r <= cy + 1; r++) for (let c = cx - 1; c <= cx + 1; c++) {
        if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) continue;
        if (State.tiles[r][c].type === "grass" && Math.random() > 0.4) {
          State.tiles[r][c].type = "stone";
          State.tiles[r][c].stoneYield = 5 + Math.floor(Math.random() * 5);
        }
      }
    }

    // Update walkability
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      const t = State.tiles[r][c];
      t.walkable = t.type !== "water";
    }

    // Find a clean grass cluster for the starting village (center-ish)
    const startR = Math.floor(GRID_ROWS * 0.65);
    const startC = Math.floor(GRID_COLS * 0.45);
    const villageCells = [];
    for (let r = startR - 3; r <= startR + 3; r++) for (let c = startC - 3; c <= startC + 3; c++) {
      if (r < 0 || r >= GRID_ROWS || c < 0 || c >= GRID_COLS) continue;
      const t = State.tiles[r][c];
      if (t.type === "grass") villageCells.push({ r, c });
    }

    // Plant some farmland near village
    for (let i = 0; i < 6; i++) {
      const cell = villageCells[Math.floor(Math.random() * villageCells.length)];
      if (!cell) break;
      const t = State.tiles[cell.r][cell.c];
      t.type = "farmland";
      t.foodYield = 8 + Math.floor(Math.random() * 6);
    }

    // Initial buildings
    State.buildings = [];
    const placeBuilding = (kind, r, c) => {
      State.buildings.push({
        id: newId(), kind, row: r, col: c, level: 1,
        smokePhase: Math.random() * Math.PI * 2,
        sway: Math.random() * Math.PI * 2,
      });
    };
    const isOccupied = (r, c) => State.buildings.some((b) => b.row === r && b.col === c);
    let placed = 0;
    for (const cell of villageCells) {
      if (placed >= 4) break;
      const t = State.tiles[cell.r][cell.c];
      if (t.type !== "grass") continue;
      if (isOccupied(cell.r, cell.c)) continue;
      placeBuilding("house", cell.r, cell.c);
      placed++;
    }
    // Farm on a farmland tile not yet occupied
    const farmCell = villageCells.find((cell) => State.tiles[cell.r][cell.c].type === "farmland" && !isOccupied(cell.r, cell.c));
    if (farmCell) placeBuilding("farm", farmCell.r, farmCell.c);
    // Church on grass adjacent to village, not on a house
    const churchCell = villageCells.find((cell) => State.tiles[cell.r][cell.c].type === "grass" && !isOccupied(cell.r, cell.c));
    if (churchCell) placeBuilding("church", churchCell.r, churchCell.c);

    // Initial citizens
    State.citizens = [];
    const houses = State.buildings.filter((b) => b.kind === "house");
    const roles = ["Farmer", "Farmer", "Builder", "Woodcutter", "Merchant", "Priest", "Guard"];
    for (let i = 0; i < 7; i++) {
      const home = houses[i % houses.length];
      const gender = Math.random() < 0.5 ? "M" : "F";
      const role = roles[i];
      spawnCitizen({ home, role, gender, age: 18 + Math.floor(Math.random() * 28) });
    }

    // Initial sheep
    State.animals = [];
    const grassCells = [];
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      if (State.tiles[r][c].type === "grass") grassCells.push({ r, c });
    }
    for (let i = 0; i < 8; i++) {
      const cell = grassCells[Math.floor(Math.random() * grassCells.length)];
      if (!cell) break;
      State.animals.push({
        id: newId(), kind: "sheep",
        row: cell.r, col: cell.c, vrow: cell.r, vcol: cell.c,
        dir: "S", nextWanderAt: 0,
        sway: Math.random() * Math.PI * 2,
      });
    }

    // Center camera on village
    const iso = isoToScreen(startC, startR);
    State.camera.x = window.innerWidth / 2 - iso.x;
    State.camera.y = window.innerHeight / 2 - iso.y;
  }

  function spawnCitizen({ home, role, gender, age }) {
    const lifespan = 50 + Math.floor(Math.random() * 30);
    const work = pickWorkplace(role);
    const c = {
      id: newId(),
      name: pickName(gender),
      gender, age, role,
      hunger: 70 + Math.floor(Math.random() * 25),
      health: 90 + Math.floor(Math.random() * 10),
      happiness: 60 + Math.floor(Math.random() * 30),
      mood: "Content",
      gold: Math.floor(Math.random() * 15),
      lifespan,
      birthAt: State.time.totalDays - age * SEASON_DAYS * 4,
      home: home ? { row: home.row, col: home.col, id: home.id } : null,
      work: work ? { row: work.row, col: work.col, id: work.id, kind: work.kind } : null,
      row: home ? home.row : Math.floor(GRID_ROWS / 2),
      col: home ? home.col : Math.floor(GRID_COLS / 2),
      vrow: home ? home.row : Math.floor(GRID_ROWS / 2),
      vcol: home ? home.col : Math.floor(GRID_COLS / 2),
      target: null,
      path: [],
      state: "IDLE",      // IDLE | WALK | WORK | EAT | REST | SICK | THIEF | ARREST | JAIL | DRINK | PRAY | DEAD
      stateUntil: 0,
      sickness: 0,        // medicine: 0-100; >40 = visibly sick
      crimeStreak: 0,     // crime: rises with low faith + low happiness
      jailedUntilDay: 0,
      lastLeisureDay: 0,
      lastEatDay: 0,
      sway: Math.random() * Math.PI * 2,
      bobPhase: Math.random() * Math.PI * 2,
      blessUntilDay: 0,
      dissolveAt: 0,
    };
    State.citizens.push(c);
    return c;
  }

  function pickWorkplace(role) {
    const wantKind = {
      Farmer: "farm", Builder: "house", Woodcutter: "forest",
      Merchant: "market", Priest: "church", Guard: "dungeon",
    }[role];
    if (wantKind === "forest") {
      // pick a random forest tile
      const forests = [];
      for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
        if (State.tiles[r][c].type === "forest") forests.push({ row: r, col: c, kind: "forest", id: 0 });
      }
      return forests[Math.floor(Math.random() * forests.length)] || null;
    }
    return State.buildings.find((b) => b.kind === wantKind) || null;
  }

  // ================================================================
  //  ISO MATH
  // ================================================================
  function isoToScreen(col, row) {
    return {
      x: (col - row) * (TILE_W / 2),
      y: (col + row) * (TILE_H / 2),
    };
  }
  function screenToIso(sx, sy) {
    const col = (sx / (TILE_W / 2) + sy / (TILE_H / 2)) / 2;
    const row = (sy / (TILE_H / 2) - sx / (TILE_W / 2)) / 2;
    return { col, row };
  }
  function inBounds(r, c) { return r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS; }

  // ================================================================
  //  PATHFINDING — simple BFS on walkable tiles
  // ================================================================
  function bfsPath(sr, sc, tr, tc) {
    if (!inBounds(tr, tc) || !State.tiles[tr][tc].walkable) {
      // pick nearest walkable neighbor of target
      const neigh = [[0,1],[1,0],[0,-1],[-1,0]];
      for (const [dr, dc] of neigh) {
        if (inBounds(tr+dr, tc+dc) && State.tiles[tr+dr][tc+dc].walkable) { tr += dr; tc += dc; break; }
      }
      if (!State.tiles[tr][tc].walkable) return [];
    }
    const key = (r, c) => r * GRID_COLS + c;
    const came = new Map();
    const q = [{ r: sr, c: sc }];
    const seen = new Set([key(sr, sc)]);
    let found = false;
    while (q.length) {
      const cur = q.shift();
      if (cur.r === tr && cur.c === tc) { found = true; break; }
      for (const [dr, dc] of [[0,1],[1,0],[0,-1],[-1,0]]) {
        const nr = cur.r + dr, nc = cur.c + dc;
        if (!inBounds(nr, nc)) continue;
        if (!State.tiles[nr][nc].walkable) continue;
        const k = key(nr, nc);
        if (seen.has(k)) continue;
        seen.add(k); came.set(k, key(cur.r, cur.c));
        q.push({ r: nr, c: nc });
      }
      if (q.length > 800) break; // safety
    }
    if (!found) return [];
    const path = [];
    let cur = key(tr, tc);
    while (cur !== key(sr, sc)) {
      path.push({ r: Math.floor(cur / GRID_COLS), c: cur % GRID_COLS });
      cur = came.get(cur);
      if (cur === undefined) break;
    }
    path.reverse();
    return path;
  }

  function nearestTileOfType(sr, sc, type, maxR = 12) {
    let best = null, bestD = Infinity;
    for (let r = 0; r < GRID_ROWS; r++) for (let c = 0; c < GRID_COLS; c++) {
      if (State.tiles[r][c].type !== type) continue;
      const d = Math.abs(r - sr) + Math.abs(c - sc);
      if (d < bestD && d <= maxR) { bestD = d; best = { r, c }; }
    }
    return best;
  }

  // ================================================================
  //  SIMULATION TICK — one in-game day
  // ================================================================
  function tickDay() {
    State.time.day++;
    State.time.totalDays++;
    if (State.time.day > SEASON_DAYS) {
      State.time.day = 1;
      State.time.season = (State.time.season + 1) % 4;
      if (State.time.season === 0) State.time.year++;
      pushNotif(`The season turns to ${SEASONS[State.time.season]}.`, "good");
    }

    // Weather
    if (State.time.totalDays > State.weatherUntilDay) {
      const r = Math.random();
      if (r < 0.6) State.weather = "Clear";
      else if (r < 0.9) State.weather = "Rain";
      else State.weather = "Storm";
      State.weatherUntilDay = State.time.totalDays + 3 + Math.floor(Math.random() * 6);
    }

    // Citizens
    for (const c of State.citizens) tickCitizen(c);

    // Animals
    for (const a of State.animals) tickAnimal(a);

    // Births: any two adult opposite-gender citizens, both in a house, both happy
    maybeBirth();

    // Faith decay (slow)
    if (State.time.day % 3 === 0) State.resources.faith = Math.max(0, State.resources.faith - 1);

    // Crime trigger when faith=0
    if (State.resources.faith === 0 && Math.random() < 0.05) {
      const victim = State.citizens.filter((c) => c.gold > 0)[0];
      if (victim) {
        victim.gold = Math.max(0, victim.gold - 5);
        State.resources.gold = Math.max(0, State.resources.gold - 2);
        pushNotif(`Crime in the realm — coin stolen from ${victim.name}.`, "danger");
      }
    }

    // Plague
    if (State.plagueActive && Math.random() < 0.1) {
      const c = State.citizens[Math.floor(Math.random() * State.citizens.length)];
      if (c) c.sickness = Math.min(100, c.sickness + 35);
    }

    // Cleanup graves older than 3 years
    const purgeBefore = State.time.totalDays - SEASON_DAYS * 4 * 3;
    State.graves = State.graves.filter((g) => g.addedAt > purgeBefore);

    // Cull dead citizens (after dissolve animation completes)
    State.citizens = State.citizens.filter((c) => c.state !== "DEAD" || performance.now() < c.dissolveAt + 500);

    // Succession — keep an Elder flag on the oldest living adult.
    // When the current Elder dies (or there is none), promote the next eldest
    // and announce it. Gives the player a focal point in the village.
    const livingAdults = State.citizens.filter((c) => c.state !== "DEAD" && c.age >= 18);
    const currentElder = livingAdults.find((c) => c.isElder);
    if (!currentElder && livingAdults.length > 0) {
      livingAdults.sort((a, b) => b.age - a.age);
      const heir = livingAdults[0];
      heir.isElder = true;
      if (State.time.totalDays > 1) {
        pushNotif(`${heir.name} is now Elder of the village.`, "divine");
      }
    }

    // Extinction check
    if (State.citizens.length === 0 && !State.extinct) triggerExtinction();
  }

  function tickCitizen(c) {
    if (c.state === "DEAD") return;

    // Aging — every 30 days = 1 in-game year
    if (State.time.totalDays % 30 === 0) c.age++;
    if (c.age >= c.lifespan) { killCitizen(c, "old age"); return; }

    // Hunger drain
    c.hunger = Math.max(0, c.hunger - (c.role === "Builder" || c.role === "Woodcutter" ? 4 : 3));

    // Sickness progression / recovery
    if (c.sickness > 0) {
      c.sickness = Math.max(0, c.sickness - 0.5);
      if (c.sickness > 60) c.health = Math.max(0, c.health - 2);
    }

    // Hunger zero → starve
    if (c.hunger === 0) c.health = Math.max(0, c.health - 6);
    if (c.health === 0) { killCitizen(c, c.sickness > 50 ? "plague" : "starvation"); return; }

    // Mood / happiness drift
    if (c.hunger < 30) c.happiness = Math.max(0, c.happiness - 1);
    if (c.health < 40) c.happiness = Math.max(0, c.happiness - 1);
    if (c.happiness < 30) c.mood = "Despondent";
    else if (c.happiness < 55) c.mood = "Restless";
    else if (c.happiness < 80) c.mood = "Content";
    else c.mood = "Joyful";

    // Crime streak (low faith + low happiness)
    if (State.resources.faith < 10 && c.happiness < 30) c.crimeStreak++; else c.crimeStreak = Math.max(0, c.crimeStreak - 1);

    // Bless override
    if (State.time.totalDays < c.blessUntilDay) c.happiness = Math.min(100, c.happiness + 1);

    // Decide behavior — priority cascade
    let intent = null;
    if (c.jailedUntilDay > State.time.totalDays) intent = "JAIL";
    else if (c.crimeStreak > 12) intent = "THIEF";
    else if (c.hunger < 35) intent = "EAT";
    else if (c.sickness > 40) intent = "SICK";
    else if (c.health < 40) intent = "REST";
    else if (c.happiness < 40 && State.time.totalDays - c.lastLeisureDay > 6) intent = "DRINK";
    else if (c.role === "Priest" && Math.random() < 0.3) intent = "PRAY";
    else intent = "WORK";

    executeIntent(c, intent);

    // Visual interpolation toward target tile
    const dx = c.col - c.vcol;
    const dy = c.row - c.vrow;
    const speed = c.state === "WALK" ? 0.18 : 0.35;
    c.vcol += dx * speed;
    c.vrow += dy * speed;
  }

  function executeIntent(c, intent) {
    if (intent === "JAIL") { c.state = "JAIL"; return; }

    if (intent === "EAT") {
      // If at home/farm/storehouse with food in global pool, eat
      if (State.resources.food > 0) {
        // walk to farm or home
        const farm = State.buildings.find((b) => b.kind === "farm");
        const target = farm || (c.home ? { row: c.home.row, col: c.home.col } : null);
        if (target && (c.row !== target.row || c.col !== target.col)) {
          stepToward(c, target);
          c.state = "WALK";
        } else {
          State.resources.food = Math.max(0, State.resources.food - 4);
          c.hunger = Math.min(100, c.hunger + 35);
          c.state = "EAT";
          c.lastEatDay = State.time.totalDays;
        }
      } else {
        c.state = "IDLE";
      }
      return;
    }

    if (intent === "SICK") {
      const apoth = State.buildings.find((b) => b.kind === "apothecary");
      if (apoth) {
        if (c.row !== apoth.row || c.col !== apoth.col) { stepToward(c, apoth); c.state = "WALK"; }
        else { c.sickness = Math.max(0, c.sickness - 12); c.health = Math.min(100, c.health + 4); c.state = "REST"; }
      } else if (c.home) {
        if (c.row !== c.home.row || c.col !== c.home.col) { stepToward(c, c.home); c.state = "WALK"; }
        else { c.sickness = Math.max(0, c.sickness - 3); c.state = "REST"; }
      } else c.state = "IDLE";
      return;
    }

    if (intent === "REST") {
      if (c.home) {
        if (c.row !== c.home.row || c.col !== c.home.col) { stepToward(c, c.home); c.state = "WALK"; }
        else { c.health = Math.min(100, c.health + 3); c.state = "REST"; }
      } else c.state = "IDLE";
      return;
    }

    if (intent === "DRINK") {
      const tav = State.buildings.find((b) => b.kind === "tavern");
      if (tav) {
        if (c.row !== tav.row || c.col !== tav.col) { stepToward(c, tav); c.state = "WALK"; }
        else { c.happiness = Math.min(100, c.happiness + 18); c.state = "DRINK"; c.lastLeisureDay = State.time.totalDays; }
      } else { c.happiness = Math.min(100, c.happiness + 5); c.lastLeisureDay = State.time.totalDays; c.state = "IDLE"; }
      return;
    }

    if (intent === "THIEF") {
      // Wander and steal a coin from another citizen if adjacent
      const victim = State.citizens.find((o) => o !== c && o.gold > 0 && Math.abs(o.row - c.row) + Math.abs(o.col - c.col) <= 1);
      if (victim) {
        victim.gold = Math.max(0, victim.gold - 1);
        c.gold++;
        c.crimeStreak = 0;
        // Guard arrest chance
        const guard = State.citizens.find((g) => g.role === "Guard" && g.state !== "DEAD");
        if (guard && Math.random() < 0.5) {
          c.jailedUntilDay = State.time.totalDays + 5;
          c.state = "ARREST";
          pushNotif(`${c.name} was arrested for theft.`, "danger");
        } else {
          c.state = "THIEF";
          pushNotif(`${c.name} stole a coin in the night.`, "danger");
        }
      } else {
        wander(c); c.state = "WALK";
      }
      return;
    }

    if (intent === "PRAY") {
      const church = State.buildings.find((b) => b.kind === "church");
      if (church) {
        if (c.row !== church.row || c.col !== church.col) { stepToward(c, church); c.state = "WALK"; }
        else {
          State.resources.faith = Math.min(999, State.resources.faith + 2);
          c.happiness = Math.min(100, c.happiness + 1);
          c.state = "PRAY";
        }
      } else c.state = "IDLE";
      return;
    }

    // WORK
    if (c.work) {
      if (c.row !== c.work.row || c.col !== c.work.col) { stepToward(c, c.work); c.state = "WALK"; }
      else {
        c.state = "WORK";
        switch (c.role) {
          case "Farmer":
            if (State.time.season !== 3) { // not winter
              const yld = (State.time.totalDays < State.rainBoostUntilDay) ? 4 : 2;
              State.resources.food += yld;
              c.gold += 1;
            }
            break;
          case "Woodcutter":
            State.resources.wood += 2;
            // Deplete forest tile occasionally
            if (Math.random() < 0.05 && State.tiles[c.row][c.col].type === "forest") {
              State.tiles[c.row][c.col].type = "grass";
              State.tiles[c.row][c.col].woodYield = 0;
              c.work = pickWorkplace("Woodcutter");
            }
            c.gold += 1;
            break;
          case "Builder":
            State.resources.stone = Math.max(0, State.resources.stone - 0); // builders don't eat stone passively
            // try to upgrade housing or build new house if surplus
            if (State.resources.wood >= 30 && State.resources.stone >= 10 && Math.random() < 0.05) tryAutoBuildHouse();
            break;
          case "Merchant":
            if (State.resources.food > 50 && State.resources.gold < 999) {
              State.resources.food -= 1;
              State.resources.gold += 2;
              c.gold += 1;
            }
            break;
          case "Priest":
            State.resources.faith = Math.min(999, State.resources.faith + 1);
            break;
          case "Guard":
            // patrol
            if (Math.random() < 0.3) wander(c);
            break;
        }
      }
    } else {
      c.work = pickWorkplace(c.role);
      c.state = "IDLE";
    }
  }

  function stepToward(c, target) {
    if (c.path.length === 0 || c.path[c.path.length - 1].r !== target.row || c.path[c.path.length - 1].c !== target.col) {
      c.path = bfsPath(c.row, c.col, target.row, target.col);
    }
    if (c.path.length === 0) return;
    const next = c.path.shift();
    c.row = next.r;
    c.col = next.c;
  }

  function wander(c) {
    const opts = [[0,1],[1,0],[0,-1],[-1,0]].filter(([dr,dc]) => {
      const nr = c.row + dr, nc = c.col + dc;
      return inBounds(nr, nc) && State.tiles[nr][nc].walkable;
    });
    if (opts.length) {
      const [dr, dc] = opts[Math.floor(Math.random() * opts.length)];
      c.row += dr; c.col += dc;
    }
  }

  function tickAnimal(a) {
    if (State.time.totalDays >= a.nextWanderAt) {
      const opts = [[0,1],[1,0],[0,-1],[-1,0]].filter(([dr,dc]) => {
        const nr = a.row + dr, nc = a.col + dc;
        return inBounds(nr, nc) && State.tiles[nr][nc].walkable && State.tiles[nr][nc].type !== "water";
      });
      if (opts.length) {
        const [dr, dc] = opts[Math.floor(Math.random() * opts.length)];
        a.row += dr; a.col += dc;
        a.dir = dr > 0 ? "S" : dr < 0 ? "N" : dc > 0 ? "E" : "W";
      }
      a.nextWanderAt = State.time.totalDays + 3 + Math.floor(Math.random() * 5);
    }
    // smooth lerp
    a.vrow += (a.row - a.vrow) * 0.12;
    a.vcol += (a.col - a.vcol) * 0.12;
  }

  function maybeBirth() {
    if (State.citizens.length >= 60) return; // soft cap
    const adults = State.citizens.filter((c) => c.age >= 18 && c.age < 50 && c.happiness > 55 && c.home);
    const males = adults.filter((c) => c.gender === "M");
    const females = adults.filter((c) => c.gender === "F");
    if (males.length === 0 || females.length === 0) return;
    if (Math.random() > 0.05) return;
    const mother = females[Math.floor(Math.random() * females.length)];
    if (!mother.home) return;
    const home = State.buildings.find((b) => b.id === mother.home.id);
    if (!home) return;
    const baby = spawnCitizen({ home, role: pickChildRole(), gender: Math.random() < 0.5 ? "M" : "F", age: 0 });
    baby.state = "IDLE";
    pushNotif(`${baby.name} was born to ${mother.name}.`, "good");
    spawnSparkle(home.row, home.col);
  }

  function pickChildRole() {
    // Pick role with lowest count
    const counts = {};
    for (const r of ["Farmer","Builder","Woodcutter","Merchant","Priest","Guard"]) counts[r] = 0;
    for (const c of State.citizens) if (counts[c.role] !== undefined) counts[c.role]++;
    return Object.keys(counts).sort((a, b) => counts[a] - counts[b])[0];
  }

  function killCitizen(c, cause) {
    if (c.state === "DEAD") return;
    c.state = "DEAD";
    c.dissolveAt = performance.now();
    State.graves.push({ row: c.row, col: c.col, addedAt: State.time.totalDays });
    pushNotif(`${c.name} died of ${cause}, aged ${c.age}.`, "danger");
    // dissolve particles
    for (let i = 0; i < 12; i++) {
      const iso = isoToScreen(c.col, c.row);
      State.particles.push({
        kind: "dissolve", x: iso.x + (Math.random() - 0.5) * 10, y: iso.y - 30 + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 0.3, vy: -0.3 - Math.random() * 0.4,
        life: 500 + Math.random() * 200, born: performance.now(),
      });
    }
  }

  function tryAutoBuildHouse() {
    // find an empty grass tile near existing houses
    const houses = State.buildings.filter((b) => b.kind === "house");
    if (!houses.length) return;
    const seed = houses[Math.floor(Math.random() * houses.length)];
    const opts = [];
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const r = seed.row + dr, c = seed.col + dc;
      if (!inBounds(r, c)) continue;
      if (State.tiles[r][c].type !== "grass") continue;
      if (State.buildings.some((b) => b.row === r && b.col === c)) continue;
      opts.push({ r, c });
    }
    if (!opts.length) return;
    const pick = opts[Math.floor(Math.random() * opts.length)];
    State.resources.wood -= 30; State.resources.stone -= 10;
    State.buildings.push({ id: newId(), kind: "house", row: pick.r, col: pick.c, level: 1, smokePhase: Math.random() * Math.PI * 2, sway: Math.random() * Math.PI * 2 });
    pushNotif(`A new house was built in the village.`, "good");
  }

  function triggerExtinction() {
    State.extinct = true;
    State.time.paused = true;
    document.getElementById("extinction").classList.add("show");
  }

  // ================================================================
  //  GOD POWERS
  // ================================================================
  function castPower(power, targetTile) {
    const cost = POWER_COSTS[power];
    if (cost > 0 && State.resources.faith < cost) {
      pushNotif("Not enough Faith.", "danger"); return false;
    }
    if (cost > 0) State.resources.faith -= cost;

    switch (power) {
      case "bless": {
        const until = State.time.totalDays + 10;
        for (const c of State.citizens) { c.happiness = Math.min(100, c.happiness + 30); c.blessUntilDay = until; }
        spawnRipple(window.innerWidth / 2 - State.camera.x, window.innerHeight / 2 - State.camera.y, "#d4af6a");
        pushNotif("✨ A divine blessing washes over the realm.", "divine");
        return true;
      }
      case "strike": {
        if (!targetTile) return false;
        const iso = isoToScreen(targetTile.col, targetTile.row);
        spawnLightning(iso.x, iso.y);
        triggerShake(280, 8);
        // Damage building or citizen on tile
        const bidx = State.buildings.findIndex((b) => b.row === targetTile.row && b.col === targetTile.col);
        if (bidx !== -1) {
          const b = State.buildings.splice(bidx, 1)[0];
          pushNotif(`⚡ A bolt of judgment shattered a ${b.kind}.`, "danger");
        }
        for (const c of State.citizens) {
          if (c.row === targetTile.row && c.col === targetTile.col && c.state !== "DEAD") killCitizen(c, "divine smite");
        }
        return true;
      }
      case "rain": {
        State.rainBoostUntilDay = State.time.totalDays + 5;
        State.weather = "Rain"; State.weatherUntilDay = State.time.totalDays + 5;
        pushNotif("🌧️ Sacred rains nourish the harvests.", "divine");
        return true;
      }
      case "grow": {
        if (!targetTile) return false;
        const t = State.tiles[targetTile.row][targetTile.col];
        if (t.type === "water") { pushNotif("Cannot grow trees in water.", "danger"); State.resources.faith += cost; return false; }
        t.type = "forest"; t.woodYield = 6; t.walkable = true;
        spawnSparkle(targetTile.row, targetTile.col);
        pushNotif("🌿 Trees burst from the soil.", "divine");
        return true;
      }
      case "birth": {
        const houses = State.buildings.filter((b) => b.kind === "house");
        if (!houses.length) { pushNotif("No house to receive the child.", "danger"); State.resources.faith += cost; return false; }
        const home = houses[Math.floor(Math.random() * houses.length)];
        const baby = spawnCitizen({ home, role: pickChildRole(), gender: Math.random() < 0.5 ? "M" : "F", age: 0 });
        spawnSparkle(home.row, home.col);
        pushNotif(`👶 ${baby.name} appears by miracle.`, "divine");
        return true;
      }
      case "plague": {
        State.plagueActive = true;
        for (let i = 0; i < Math.min(3, State.citizens.length); i++) {
          const c = State.citizens[Math.floor(Math.random() * State.citizens.length)];
          c.sickness = 70;
        }
        pushNotif("💀 A pestilent wind blows across the land.", "danger");
        // plague auto-clears after 30 days
        setTimeout(() => { State.plagueActive = false; }, 30 * TICK_MS);
        return true;
      }
    }
    return false;
  }

  // ================================================================
  //  PARTICLES
  // ================================================================
  function spawnSparkle(row, col) {
    const iso = isoToScreen(col, row);
    for (let i = 0; i < 14; i++) {
      State.particles.push({
        kind: "sparkle",
        x: iso.x + (Math.random() - 0.5) * 30,
        y: iso.y + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * 0.6,
        vy: -0.4 - Math.random() * 0.5,
        life: 700 + Math.random() * 400, born: performance.now(),
      });
    }
  }
  function spawnRipple(sx, sy, color) {
    State.particles.push({ kind: "ripple", x: sx, y: sy, r: 8, color, life: 900, born: performance.now() });
  }
  function spawnLightning(sx, sy) {
    State.particles.push({ kind: "lightning", x: sx, y: sy, life: 320, born: performance.now() });
    State.particles.push({ kind: "flash", life: 150, born: performance.now() });
  }
  function triggerShake(ms, mag) {
    State.shake.until = performance.now() + ms;
    State.shake.mag = mag;
  }

  function tickParticles(dt) {
    const now = performance.now();
    // emit smoke from chimneys
    for (const b of State.buildings) {
      if (b.kind !== "house") continue;
      if (Math.random() < 0.06) {
        const iso = isoToScreen(b.col, b.row);
        State.particles.push({
          kind: "smoke",
          x: iso.x + (Math.random() - 0.5) * 8,
          y: iso.y - 70,
          vx: (Math.random() - 0.5) * 0.1, vy: -0.3 - Math.random() * 0.2,
          life: 1800 + Math.random() * 600, born: now, r: 3 + Math.random() * 2,
        });
      }
    }
    // emit weather particles per frame
    if (SEASONS[State.time.season] === "Autumn") {
      if (Math.random() < 0.4) {
        State.particles.push({
          kind: "leaf",
          x: Math.random() * window.innerWidth - State.camera.x,
          y: -State.camera.y + Math.random() * 40,
          vx: 0.3 + Math.random() * 0.3, vy: 0.2 + Math.random() * 0.3,
          life: 6000, born: now, rot: Math.random() * Math.PI * 2,
        });
      }
    }
    if (SEASONS[State.time.season] === "Winter" || State.weather === "Storm") {
      if (Math.random() < 0.7) {
        State.particles.push({
          kind: "snow",
          x: Math.random() * window.innerWidth - State.camera.x,
          y: -State.camera.y + Math.random() * 40,
          vx: -0.05 + Math.random() * 0.1, vy: 0.4 + Math.random() * 0.3,
          life: 5000, born: now, r: 1.5 + Math.random() * 1.5,
        });
      }
    }
    if (State.weather === "Rain" || State.weather === "Storm") {
      if (Math.random() < 1.0) {
        State.particles.push({
          kind: "rain",
          x: Math.random() * window.innerWidth - State.camera.x,
          y: -State.camera.y + Math.random() * 40,
          vx: -0.3, vy: 2.2,
          life: 1200, born: now,
        });
      }
    }
    // Random storm lightning
    if (State.weather === "Storm" && Math.random() < 0.003) {
      State.particles.push({ kind: "flash", life: 120, born: now });
      triggerShake(180, 4);
    }

    // advance & cull
    State.particles = State.particles.filter((p) => {
      const age = now - p.born;
      if (age > p.life) return false;
      if (p.vx !== undefined) p.x += p.vx * dt * 0.06;
      if (p.vy !== undefined) p.y += p.vy * dt * 0.06;
      if (p.kind === "ripple") p.r += 0.18 * dt * 0.06;
      return true;
    });
  }

  // ================================================================
  //  RENDER
  // ================================================================
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);

  function render() {
    const W = window.innerWidth, H = window.innerHeight;
    const now = performance.now();

    // Backdrop — deep night blue/black
    ctx.fillStyle = "#0a090e";
    ctx.fillRect(0, 0, W, H);

    // Camera + shake
    let shakeX = 0, shakeY = 0;
    if (now < State.shake.until) {
      shakeX = (Math.random() - 0.5) * State.shake.mag;
      shakeY = (Math.random() - 0.5) * State.shake.mag;
    }
    ctx.save();
    ctx.translate(State.camera.x + shakeX, State.camera.y + shakeY);

    // ===== Pass 1: ground tiles =====
    drawGround(now);

    // ===== Pass 2: y-sorted entities (trees, buildings, citizens, animals, graves) =====
    const queue = [];
    // Trees on every forest tile, anchored bottom-center, with sway
    const trees = drawTrees(now) || [];
    for (const t of trees) {
      queue.push({
        key: t.key,
        draw: () => {
          ctx.save();
          ctx.translate(t.x, t.y);
          ctx.scale(1, t.sway);
          ctx.drawImage(t.treeImg, -t.treeW / 2, -t.treeH, t.treeW, t.treeH);
          ctx.restore();
        },
      });
    }
    for (const b of State.buildings) {
      queue.push({ key: b.row + b.col - 0.5, draw: () => drawBuildingFloor(b) });
      queue.push({ key: b.row + b.col,        draw: () => drawBuilding(b, now) });
    }
    for (const g of State.graves) queue.push({ key: g.row + g.col + 0.001, draw: () => drawGrave(g) });
    for (const a of State.animals) queue.push({ key: a.vrow + a.vcol + 0.005, draw: () => drawSheep(a, now) });
    for (const c of State.citizens) queue.push({ key: c.vrow + c.vcol + 0.01,  draw: () => drawCitizen(c, now) });
    queue.sort((a, b) => a.key - b.key);
    for (const e of queue) e.draw();

    // ===== Pass 3: in-world particles (smoke, sparkle, ripple, lightning, dissolve) =====
    drawWorldParticles(now);

    ctx.restore();

    // ===== Pass 4: screen-space particles (rain, snow, leaves, flash) =====
    ctx.save();
    ctx.translate(State.camera.x, State.camera.y);
    drawScreenParticles(now);
    ctx.restore();

    // ===== Pass 5: warm tint (multiply) =====
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    if (SEASONS[State.time.season] === "Winter") ctx.fillStyle = "rgba(210, 230, 255, 0.12)";
    else ctx.fillStyle = "rgba(255, 240, 210, 0.10)";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    // ===== Pass 6: vignette =====
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.78);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.55, "rgba(0,0,0,0.18)");
    grad.addColorStop(1, "rgba(4,2,8,0.72)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // ===== Pass 7: lightning flash overlay =====
    for (const p of State.particles) {
      if (p.kind !== "flash") continue;
      const age = now - p.born;
      const a = Math.max(0, 1 - age / p.life) * 0.35;
      ctx.fillStyle = `rgba(220, 230, 255, ${a})`;
      ctx.fillRect(0, 0, W, H);
    }

    // ===== Pass 8: speed vignette at x20 =====
    if (State.time.scale === 20) {
      const sv = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.20, W / 2, H / 2, Math.max(W, H) * 0.7);
      sv.addColorStop(0, "rgba(0,0,0,0)");
      sv.addColorStop(1, "rgba(0,0,0,0.34)");
      ctx.fillStyle = sv;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawGround(now) {
    const grassImg = Assets.images.grass;
    const sandImg  = Assets.images.sand;
    const isWinter = SEASONS[State.time.season] === "Winter";
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const t = State.tiles[r][c];
        const { x, y } = isoToScreen(c, r);

        // STEP 1 — Always paint a flat seamless palette diamond as the
        // base layer. This guarantees the world tessellates with no
        // black gaps, even where PNGs have transparent margins.
        let baseColor;
        if (t.type === "water") baseColor = isWinter ? "#5d7a96" : PALETTE.water;
        else if (t.type === "sand") baseColor = PALETTE.sand;
        else if (t.type === "forest") baseColor = PALETTE.forest;
        else if (t.type === "farmland") baseColor = PALETTE.farmland;
        else if (t.type === "stone") baseColor = PALETTE.stone;
        else if (t.type === "road") baseColor = PALETTE.road;
        else if (t.type === "snow") baseColor = PALETTE.snow;
        else baseColor = isWinter ? PALETTE.snow : PALETTE.grass;
        drawDiamond(x, y, baseColor);

        // STEP 2 — Stamp the PNG on top for biomes that have one.
        // Skip in winter so the snow palette reads through cleanly.
        if (!isWinter) {
          if (t.type === "grass" || t.type === "forest") {
            if (grassImg) ctx.drawImage(grassImg, x - TILE_W / 2, y - TILE_H / 2, TILE_W, TILE_H);
          } else if (t.type === "sand") {
            if (sandImg) ctx.drawImage(sandImg, x - TILE_W / 2, y - TILE_H / 2, TILE_W, TILE_H);
          }
        }

        // STEP 3 — Subtle biome tint overlays for the in-grass variants
        if (t.type === "farmland") drawDiamond(x, y, "rgba(168, 147, 96, 0.55)");
        else if (t.type === "stone") drawDiamond(x, y, "rgba(122, 126, 132, 0.65)");
        else if (t.type === "road") drawDiamond(x, y, "rgba(107, 93, 72, 0.6)");

        // Animated water shimmer
        if (t.type === "water") {
          const shimmer = Math.sin(now / 600 + (r * 0.7 + c * 0.3)) * 0.3 + 0.5;
          ctx.fillStyle = `rgba(180, 210, 230, ${0.08 * shimmer})`;
          drawDiamondPath(x, y); ctx.fill();
          // foam at land-adjacent edges
          for (const [dr, dc, side] of [[-1,0,"N"],[0,1,"E"],[1,0,"S"],[0,-1,"W"]]) {
            const nr = r + dr, nc = c + dc;
            if (!inBounds(nr, nc)) continue;
            if (State.tiles[nr][nc].type === "water") continue;
            ctx.strokeStyle = "rgba(220, 230, 240, 0.45)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (side === "N") { ctx.moveTo(x - TILE_W/2, y); ctx.lineTo(x, y - TILE_H/2); }
            else if (side === "E") { ctx.moveTo(x, y - TILE_H/2); ctx.lineTo(x + TILE_W/2, y); }
            else if (side === "S") { ctx.moveTo(x + TILE_W/2, y); ctx.lineTo(x, y + TILE_H/2); }
            else { ctx.moveTo(x, y + TILE_H/2); ctx.lineTo(x - TILE_W/2, y); }
            ctx.stroke();
          }
        }
      }
    }
  }

  function drawTrees(now) {
    const treeImg = Assets.images.tree;
    if (!treeImg) return;
    const treeW = TILE_W * 0.55;
    const treeH = treeW * (treeImg.naturalHeight / treeImg.naturalWidth);
    const out = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        if (State.tiles[r][c].type !== "forest") continue;
        const { x, y } = isoToScreen(c, r);
        const phase = (r * 7 + c * 13) * 0.31;
        const sway = 1 + Math.sin(now / 900 + phase) * 0.025;
        out.push({ key: r + c - 0.05, x, y, sway, treeW, treeH, treeImg });
      }
    }
    return out;
  }

  function drawDiamond(x, y, fill) {
    drawDiamondPath(x, y);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function drawDiamondPath(x, y) {
    ctx.beginPath();
    ctx.moveTo(x, y - TILE_H / 2);
    ctx.lineTo(x + TILE_W / 2, y);
    ctx.lineTo(x, y + TILE_H / 2);
    ctx.lineTo(x - TILE_W / 2, y);
    ctx.closePath();
  }

  function drawBuildingFloor(b) {
    // Subtle warm-stone foundation diamond
    const { x, y } = isoToScreen(b.col, b.row);
    drawDiamondPath(x, y);
    ctx.fillStyle = "rgba(82, 64, 44, 0.6)";
    ctx.fill();
  }

  function drawBuilding(b, now) {
    const { x, y } = isoToScreen(b.col, b.row);
    const sway = Math.sin(now / 1400 + b.sway) * 1.2;
    if (b.kind === "house" && Assets.images.house) {
      const img = Assets.images.house;
      const w = TILE_W * 1.0;
      const h = w * (img.naturalHeight / img.naturalWidth);
      // Dollhouse: check if any citizen stands on this tile → make roof transparent
      const occupied = State.citizens.some((c) => Math.round(c.vrow) === b.row && Math.round(c.vcol) === b.col);
      ctx.save();
      ctx.globalAlpha = occupied ? 0.55 : 1;
      ctx.drawImage(img, x - w / 2, y - h + sway, w, h);
      ctx.restore();
    } else if (b.kind === "house") {
      drawProcHouse(x, y + sway);
    } else if (b.kind === "farm") drawFarm(x, y + sway);
    else if (b.kind === "church") drawChurch(x, y + sway);
    else if (b.kind === "tavern") drawTavern(x, y + sway);
    else if (b.kind === "apothecary") drawApothecary(x, y + sway);
    else if (b.kind === "dungeon") drawDungeon(x, y + sway);
    else if (b.kind === "market") drawMarket(x, y + sway);
  }

  function drawProcHouse(x, y) {
    // Walls
    ctx.fillStyle = "#7a5a3e";
    ctx.fillRect(x - 32, y - 60, 64, 50);
    // Roof
    ctx.fillStyle = "#a04030";
    ctx.beginPath();
    ctx.moveTo(x - 38, y - 60);
    ctx.lineTo(x, y - 88);
    ctx.lineTo(x + 38, y - 60);
    ctx.closePath();
    ctx.fill();
    // Door
    ctx.fillStyle = "#3a2818";
    ctx.fillRect(x - 8, y - 30, 16, 22);
    // Window
    ctx.fillStyle = "#d4af6a";
    ctx.fillRect(x - 22, y - 50, 10, 10);
    ctx.fillRect(x + 12, y - 50, 10, 10);
  }
  function drawFarm(x, y) {
    ctx.fillStyle = "#a8804a"; ctx.fillRect(x - 28, y - 52, 56, 42);
    ctx.fillStyle = "#7a5a30"; ctx.beginPath();
    ctx.moveTo(x - 32, y - 52); ctx.lineTo(x, y - 76); ctx.lineTo(x + 32, y - 52); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#d4c068"; ctx.fillRect(x - 22, y - 12, 44, 6);
  }
  function drawChurch(x, y) {
    ctx.fillStyle = "#a89a82"; ctx.fillRect(x - 28, y - 70, 56, 60);
    ctx.fillStyle = "#5a4838"; ctx.beginPath();
    ctx.moveTo(x - 30, y - 70); ctx.lineTo(x, y - 100); ctx.lineTo(x + 30, y - 70); ctx.closePath(); ctx.fill();
    // Cross
    ctx.fillStyle = "#d4af6a";
    ctx.fillRect(x - 1.5, y - 116, 3, 18);
    ctx.fillRect(x - 6, y - 110, 12, 3);
  }
  function drawTavern(x, y) {
    ctx.fillStyle = "#6a4a2e"; ctx.fillRect(x - 30, y - 56, 60, 46);
    ctx.fillStyle = "#3a2818"; ctx.fillRect(x - 8, y - 30, 16, 22);
    ctx.fillStyle = "#c08850"; ctx.fillRect(x - 32, y - 60, 64, 6);
  }
  function drawApothecary(x, y) {
    ctx.fillStyle = "#4a6a4a"; ctx.fillRect(x - 28, y - 56, 56, 46);
    ctx.fillStyle = "#d4af6a"; ctx.beginPath();
    ctx.arc(x, y - 42, 8, 0, Math.PI * 2); ctx.fill();
  }
  function drawDungeon(x, y) {
    ctx.fillStyle = "#3a3a44"; ctx.fillRect(x - 30, y - 50, 60, 40);
    ctx.fillStyle = "#1a1a22"; ctx.fillRect(x - 6, y - 32, 12, 22);
  }
  function drawMarket(x, y) {
    ctx.fillStyle = "#a04030"; ctx.beginPath();
    ctx.moveTo(x - 32, y - 30); ctx.lineTo(x, y - 50); ctx.lineTo(x + 32, y - 30); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#7a5a3e"; ctx.fillRect(x - 28, y - 30, 56, 22);
  }

  function drawGrave(g) {
    const { x, y } = isoToScreen(g.col, g.row);
    ctx.fillStyle = "#5a5a64";
    ctx.fillRect(x - 6, y - 18, 12, 18);
    ctx.fillStyle = "#7a7a84";
    ctx.fillRect(x - 8, y - 22, 16, 6);
  }

  function drawCitizen(c, now) {
    const { x, y } = isoToScreen(c.vcol, c.vrow);
    if (c.state === "DEAD") {
      const fade = 1 - Math.min(1, (now - c.dissolveAt) / 500);
      if (fade <= 0) return;
      ctx.globalAlpha = fade;
    }
    // Dolls — bobbing while walking, breathing while idle
    const moving = c.state === "WALK";
    const bob = moving ? Math.sin(now / 160 + c.bobPhase) * 2 : Math.sin(now / 1100 + c.bobPhase) * 0.6;
    const cx = x;
    const cy = y - 28 + bob;
    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath(); ctx.ellipse(x, y, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
    // Body — role tunic
    const bodyColor = c.age < 12 ? ROLE_COLORS.Child : (ROLE_COLORS[c.role] || "#7a8090");
    if (c.state === "JAIL") ctx.fillStyle = "#3a3a44"; else ctx.fillStyle = bodyColor;
    ctx.fillRect(cx - 6, cy, 12, 16);
    // Head
    ctx.fillStyle = "#e8c89a";
    ctx.beginPath(); ctx.arc(cx, cy - 4, 5, 0, Math.PI * 2); ctx.fill();
    // Hair
    ctx.fillStyle = c.gender === "F" ? "#5a3a28" : "#3a2818";
    ctx.beginPath(); ctx.arc(cx, cy - 6, 5, Math.PI, 0); ctx.fill();
    // Sickness aura
    if (c.sickness > 40) {
      ctx.fillStyle = `rgba(120, 200, 120, ${0.25 + Math.sin(now / 300) * 0.1})`;
      ctx.beginPath(); ctx.arc(cx, cy + 4, 14, 0, Math.PI * 2); ctx.fill();
    }
    // Bless aura
    if (State.time.totalDays < c.blessUntilDay) {
      ctx.strokeStyle = `rgba(212, 175, 106, ${0.6 + Math.sin(now / 200) * 0.2})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy + 4, 14, 0, Math.PI * 2); ctx.stroke();
    }
    // Elder crown — small gold cap on the village leader
    if (c.isElder) {
      ctx.fillStyle = "#d4af6a";
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - 8);
      ctx.lineTo(cx - 3, cy - 12);
      ctx.lineTo(cx, cy - 9);
      ctx.lineTo(cx + 3, cy - 12);
      ctx.lineTo(cx + 5, cy - 8);
      ctx.closePath();
      ctx.fill();
    }
    // State indicator
    if (c.state === "EAT") drawTinyIcon(cx + 9, cy - 6, "🍞");
    else if (c.state === "PRAY") drawTinyIcon(cx + 9, cy - 6, "✨");
    else if (c.state === "DRINK") drawTinyIcon(cx + 9, cy - 6, "🍺");
    else if (c.state === "JAIL") drawTinyIcon(cx + 9, cy - 6, "🔒");
    else if (c.state === "THIEF") drawTinyIcon(cx + 9, cy - 6, "🗡");

    if (c.state === "DEAD") ctx.globalAlpha = 1;
  }

  function drawTinyIcon(x, y, ch) {
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(ch, x, y);
  }

  function drawSheep(a, now) {
    const { x, y } = isoToScreen(a.vcol, a.vrow);
    const sway = Math.sin(now / 800 + a.sway) * 0.6;
    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.beginPath(); ctx.ellipse(x, y, 11, 3, 0, 0, Math.PI * 2); ctx.fill();
    // Body
    ctx.fillStyle = "#f1ece0";
    ctx.beginPath(); ctx.ellipse(x, y - 6 + sway, 11, 7, 0, 0, Math.PI * 2); ctx.fill();
    // Head
    ctx.fillStyle = "#3a3028";
    const hx = x + (a.dir === "E" ? 8 : a.dir === "W" ? -8 : 0);
    ctx.beginPath(); ctx.arc(hx, y - 8 + sway, 3.5, 0, Math.PI * 2); ctx.fill();
    // Legs
    ctx.fillStyle = "#3a3028";
    ctx.fillRect(x - 7, y - 2, 1.6, 4);
    ctx.fillRect(x + 5, y - 2, 1.6, 4);
    ctx.fillRect(x - 3, y - 2, 1.6, 4);
    ctx.fillRect(x + 1, y - 2, 1.6, 4);
  }

  function drawWorldParticles(now) {
    for (const p of State.particles) {
      const age = now - p.born;
      const a = Math.max(0, 1 - age / p.life);
      if (p.kind === "smoke") {
        ctx.fillStyle = `rgba(180, 180, 190, ${a * 0.4})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + age / p.life), 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "sparkle") {
        ctx.fillStyle = `rgba(212, 175, 106, ${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "ripple") {
        ctx.strokeStyle = `${p.color}${Math.floor(a * 255).toString(16).padStart(2, "0")}`;
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
      } else if (p.kind === "lightning") {
        ctx.strokeStyle = `rgba(220, 230, 255, ${a})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        let lx = p.x, ly = p.y - 600;
        ctx.moveTo(lx, ly);
        while (ly < p.y) {
          lx += (Math.random() - 0.5) * 30;
          ly += 28 + Math.random() * 10;
          ctx.lineTo(lx, ly);
        }
        ctx.stroke();
      } else if (p.kind === "dissolve") {
        ctx.fillStyle = `rgba(212, 175, 106, ${a * 0.7})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawScreenParticles(now) {
    for (const p of State.particles) {
      const age = now - p.born;
      const a = Math.max(0, 1 - age / p.life);
      if (p.kind === "rain") {
        ctx.strokeStyle = `rgba(160, 180, 210, ${a * 0.45})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 3, p.y + 14); ctx.stroke();
      } else if (p.kind === "snow") {
        ctx.fillStyle = `rgba(240, 245, 255, ${a * 0.85})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "leaf") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot + age / 600);
        ctx.fillStyle = `rgba(180, 110, 60, ${a * 0.8})`;
        ctx.beginPath(); ctx.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ================================================================
  //  UI — HUD UPDATES, NOTIFICATIONS, INSPECT, INPUT
  // ================================================================
  const lastResShown = { food: -1, wood: -1, stone: -1, gold: -1, faith: -1 };
  function updateHUD() {
    document.getElementById("ck-day").textContent = State.time.day;
    document.getElementById("ck-season").textContent = SEASONS[State.time.season];
    document.getElementById("ck-year").textContent = State.time.year;
    document.getElementById("ck-weather").textContent = State.weather;

    document.querySelectorAll("#resource-bar .res").forEach((el) => {
      const r = el.dataset.r;
      const v = Math.floor(State.resources[r]);
      const numEl = el.querySelector(".num");
      const prev = parseInt(numEl.textContent, 10);
      if (prev !== v) {
        numEl.textContent = v;
        if (v > lastResShown[r]) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
        lastResShown[r] = v;
      }
    });

    document.querySelectorAll(".power-btn").forEach((btn) => {
      const cost = POWER_COSTS[btn.dataset.power];
      btn.classList.toggle("disabled", cost > 0 && State.resources.faith < cost);
      btn.classList.toggle("active", State.activePower === btn.dataset.power);
    });

    document.querySelectorAll(".tc-btn").forEach((btn) => {
      const cmd = btn.dataset.cmd;
      let isActive = false;
      if (cmd === "pause" && State.time.paused) isActive = true;
      if (cmd === "play" && !State.time.paused && State.time.scale === 1) isActive = true;
      if (cmd === "x5" && State.time.scale === 5) isActive = true;
      if (cmd === "x20" && State.time.scale === 20) isActive = true;
      btn.classList.toggle("active", isActive);
    });

    if (State.selected && State.selected.kind === "citizen") {
      const c = State.selected.ref;
      if (c.state === "DEAD") { hideInspect(); }
      else renderInspectCitizen(c);
    } else if (State.selected && State.selected.kind === "tile") {
      renderInspectTile(State.selected.ref);
    }
  }

  function pushNotif(text, kind = "good") {
    const root = document.getElementById("notifications");
    const el = document.createElement("div");
    el.className = `notif panel ${kind}`;
    el.textContent = text;
    root.appendChild(el);
    setTimeout(() => el.remove(), 8200);
    while (root.children.length > 4) root.removeChild(root.firstChild);
  }

  function renderInspectCitizen(c) {
    const ip = document.getElementById("inspect");
    const bar = (label, v, max=100) => {
      const pct = Math.max(0, Math.min(1, v / max)) * 100;
      const cls = v < 25 ? "danger" : v < 50 ? "warn" : "";
      return `<div class="row"><span class="lbl">${label}</span><div style="display:flex;align-items:center;gap:8px;"><span class="val">${Math.floor(v)}</span><div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div></div></div>`;
    };
    ip.innerHTML = `
      <span class="close" data-close>×</span>
      <h3>${c.name}${c.isElder ? " 👑" : ""}</h3>
      <div class="sub">${c.isElder ? "Elder · " : ""}${c.gender === "F" ? "Lady" : "Lord"} · Age ${c.age} · ${c.role}</div>
      ${bar("Hunger", c.hunger)}
      ${bar("Health", c.health)}
      ${bar("Happiness", c.happiness)}
      <div class="row"><span class="lbl">Mood</span><span class="val">${c.mood}</span></div>
      <div class="row"><span class="lbl">Gold</span><span class="val">${c.gold} 💰</span></div>
      <div class="row"><span class="lbl">State</span><span class="val">${c.state}</span></div>
      ${c.sickness > 0 ? bar("Sickness", c.sickness) : ""}
    `;
    showInspect();
    ip.querySelector("[data-close]").onclick = () => { State.selected = null; hideInspect(); };
  }

  function renderInspectTile(t) {
    const ip = document.getElementById("inspect");
    ip.innerHTML = `
      <span class="close" data-close>×</span>
      <h3>${t.type[0].toUpperCase() + t.type.slice(1)}</h3>
      <div class="sub">Tile · row ${t.row}, col ${t.col}</div>
      <div class="row"><span class="lbl">Walkable</span><span class="val">${t.walkable ? "yes" : "no"}</span></div>
      ${t.foodYield ? `<div class="row"><span class="lbl">Food yield</span><span class="val">${t.foodYield}</span></div>` : ""}
      ${t.woodYield ? `<div class="row"><span class="lbl">Wood yield</span><span class="val">${t.woodYield}</span></div>` : ""}
      ${t.stoneYield ? `<div class="row"><span class="lbl">Stone yield</span><span class="val">${t.stoneYield}</span></div>` : ""}
    `;
    showInspect();
    ip.querySelector("[data-close]").onclick = () => { State.selected = null; hideInspect(); };
  }

  function showInspect() {
    const ip = document.getElementById("inspect");
    // anchor near top-right of canvas, below resource bar
    ip.style.left = (window.innerWidth - 360) + "px";
    ip.style.top = "80px";
    ip.classList.add("show");
  }
  function hideInspect() { document.getElementById("inspect").classList.remove("show"); }

  // ---- input ----
  function setupInput() {
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      State.cameraDrag = { x: e.clientX, y: e.clientY, cx: State.camera.x, cy: State.camera.y, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!State.cameraDrag) return;
      const dx = e.clientX - State.cameraDrag.x;
      const dy = e.clientY - State.cameraDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) State.cameraDrag.moved = true;
      State.camera.x = State.cameraDrag.cx + dx;
      State.camera.y = State.cameraDrag.cy + dy;
    });
    window.addEventListener("mouseup", (e) => {
      if (!State.cameraDrag) return;
      const wasDrag = State.cameraDrag.moved;
      State.cameraDrag = null;
      if (wasDrag) return;
      // click-to-target / inspect
      const sx = e.clientX - State.camera.x;
      const sy = e.clientY - State.camera.y;
      handleWorldClick(sx, sy);
    });

    document.querySelectorAll(".tc-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        if (cmd === "pause") State.time.paused = true;
        else if (cmd === "play") { State.time.paused = false; State.time.scale = 1; }
        else if (cmd === "x5") { State.time.paused = false; State.time.scale = 5; }
        else if (cmd === "x20") { State.time.paused = false; State.time.scale = 20; }
        else if (cmd === "sleep") {
          // fast-forward to next season boundary
          const daysLeft = SEASON_DAYS - State.time.day + 1;
          for (let i = 0; i < daysLeft; i++) tickDay();
        }
      });
    });

    document.querySelectorAll(".power-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const power = btn.dataset.power;
        const cost = POWER_COSTS[power];
        if (cost > 0 && State.resources.faith < cost) { pushNotif("Not enough Faith.", "danger"); return; }
        // Instant powers
        if (power === "bless" || power === "rain" || power === "birth" || power === "plague") {
          castPower(power);
        } else {
          // Targeted powers
          State.activePower = State.activePower === power ? null : power;
          canvas.classList.toggle("targeting", !!State.activePower);
        }
      });
    });

    document.getElementById("extinction-restart").addEventListener("click", () => {
      document.getElementById("extinction").classList.remove("show");
      State.extinct = false;
      State.time = { day: 1, season: 0, year: 1, paused: false, scale: 1, accum: 0, totalDays: 0 };
      State.resources = { food: 220, wood: 80, stone: 40, gold: 50, faith: 100 };
      State.notifications = [];
      State.particles = [];
      State.graves = [];
      generateWorld();
      pushNotif("✨ A new dawn breaks. The world begins anew.", "divine");
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === " ") { e.preventDefault(); State.time.paused = !State.time.paused; }
      else if (e.key === "1") { State.time.paused = false; State.time.scale = 1; }
      else if (e.key === "2") { State.time.paused = false; State.time.scale = 5; }
      else if (e.key === "3") { State.time.paused = false; State.time.scale = 20; }
      else if (e.key === "Escape") { State.activePower = null; canvas.classList.remove("targeting"); State.selected = null; hideInspect(); }
    });
  }

  function handleWorldClick(sx, sy) {
    const { col, row } = screenToIso(sx, sy);
    const r = Math.round(row), c = Math.round(col);
    if (!inBounds(r, c)) return;

    if (State.activePower) {
      const target = { row: r, col: c };
      castPower(State.activePower, target);
      State.activePower = null;
      canvas.classList.remove("targeting");
      return;
    }

    // Pick citizen first (closest to click)
    let bestCit = null, bestD = Infinity;
    for (const ct of State.citizens) {
      const iso = isoToScreen(ct.vcol, ct.vrow);
      const dx = iso.x - sx, dy = (iso.y - 28) - sy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 22 && d < bestD) { bestD = d; bestCit = ct; }
    }
    if (bestCit) {
      State.selected = { kind: "citizen", ref: bestCit };
      return;
    }

    // Otherwise tile
    State.selected = { kind: "tile", ref: { ...State.tiles[r][c], row: r, col: c } };
  }

  // ================================================================
  //  MAIN LOOP
  // ================================================================
  let lastFrame = 0;
  function loop(now) {
    const dt = lastFrame ? now - lastFrame : 16;
    lastFrame = now;

    // Sim: accumulator-based fixed tick scaled by State.time.scale
    if (!State.time.paused && !State.extinct) {
      State.time.accum += dt * State.time.scale;
      while (State.time.accum >= TICK_MS) {
        State.time.accum -= TICK_MS;
        tickDay();
      }
    }

    tickParticles(dt);
    render();
    updateHUD();

    requestAnimationFrame(loop);
  }

  // ================================================================
  //  BOOT
  // ================================================================
  function boot() {
    resize();
    setupInput();
    loadAssets().then(() => {
      generateWorld();
      // Spawn 3 sample auxiliary buildings to give the simulation depth
      const houses = State.buildings.filter((b) => b.kind === "house");
      const seed = houses[0];
      if (seed) {
        // Tavern, apothecary, dungeon, market — search outward for first
        // unoccupied grass tile so we never stack on top of an existing building.
        const tryPlace = (kind, preferDr, preferDc) => {
          const candidates = [
            [preferDr, preferDc],
            [preferDr + 1, preferDc], [preferDr, preferDc + 1],
            [preferDr - 1, preferDc], [preferDr, preferDc - 1],
            [preferDr + 1, preferDc + 1], [preferDr - 1, preferDc - 1],
          ];
          for (const [dr, dc] of candidates) {
            const r = seed.row + dr, c = seed.col + dc;
            if (!inBounds(r, c)) continue;
            if (State.tiles[r][c].type !== "grass") continue;
            if (State.buildings.some((b) => b.row === r && b.col === c)) continue;
            State.buildings.push({ id: newId(), kind, row: r, col: c, level: 1, smokePhase: Math.random() * Math.PI * 2, sway: Math.random() * Math.PI * 2 });
            return;
          }
        };
        tryPlace("tavern", 0, 2);
        tryPlace("apothecary", 2, 0);
        tryPlace("dungeon", -2, -1);
        tryPlace("market", 1, -2);
      }
      pushNotif("✨ Your world is alive. Watch over them.", "divine");
      // Hide loading
      setTimeout(() => document.getElementById("loading").classList.add("hidden"), 200);
      lastFrame = 0;
      requestAnimationFrame(loop);
    });
  }

  boot();
})();
