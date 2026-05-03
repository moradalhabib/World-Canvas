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

  // ---------------- TIERS / TRAITS / THOUGHTS ----------------
  const TIER_BADGE = { 1: "Labourer", 2: "Middle Class", 3: "Noble", 4: "King", 5: "Queen" };
  const TIER_TINTS = { 1: "#7a8090", 2: "#5e7fa4", 3: "#8a5fa1", 4: "#d4af6a", 5: "#c897cc" };
  const ROLE_TIER  = { Farmer: 1, Builder: 1, Woodcutter: 1, Merchant: 2, Priest: 2, Guard: 2, Noble: 3, RoyalGuard: 2, King: 4, Queen: 5 };
  const TRAITS     = ["Hardworking", "Lazy", "Greedy", "Generous", "Fearful", "Brave", "Devout", "Cynical"];
  const TIER_PROMOTE_GOLD = { 1: 200, 2: 500 };
  const TIER_DEMOTE_GOLD  = { 2: 20,  3: 50 };

  // 40+ contextual thoughts indexed by citizen state
  const THOUGHTS = {
    hungry: [
      "My stomach is empty. I hope someone farms soon.",
      "I would trade good gold for one warm loaf.",
      "When did I last truly eat? The days blur.",
      "If the harvest fails again, I do not know what we will do.",
    ],
    sick: [
      "My body aches. I can barely lift the axe.",
      "A cold sweat won't leave me. I should rest.",
      "The healer's hut feels so far away today.",
    ],
    grieving: [
      "The world feels quieter without them.",
      "I keep turning to speak, then remember.",
      "Time will not knit this wound — but I will keep walking.",
    ],
    joyful: [
      "The sun feels warm on my back today.",
      "Bread, friends, and a roof — what more could one ask?",
      "I caught myself humming. It surprised me.",
    ],
    rich: [
      "Life is good. Perhaps I can build something greater.",
      "I have more coin than my father ever held. Strange feeling.",
      "Soon, perhaps, I will own land of my own.",
    ],
    blessed: [
      "I felt something divine just now. A warmth I can't explain.",
      "There is a presence in the air. It watches kindly.",
      "I will light a candle at the church tonight.",
    ],
    feared: [
      "The sky cracked open. Whatever lives up there is watching.",
      "I do not know if the gods love us or merely tolerate us.",
      "Best to keep one's head down for a few days.",
    ],
    noble: [
      "The King's edict this season is foolish. We nobles suffer for it.",
      "My estate produces well, but the peasantry grows restless.",
      "A clever Noble outlives ten brave ones.",
    ],
    king: [
      "The weight of a kingdom never truly lifts.",
      "Even a King must sleep. Briefly.",
      "If I fall, who will hold this together?",
    ],
    queen: [
      "Faith flows where joy flows. I must keep the court bright.",
      "The chapel needs new candles. I shall see to it.",
      "A Queen is the heart of a realm — no smaller a thing.",
    ],
    devout: [
      "I shall walk to the church before dusk.",
      "Every prayer, however small, is heard.",
    ],
    greedy: [
      "There must be a way to turn this season's surplus into gold.",
      "I should check the market prices again.",
    ],
    lazy: [
      "Surely the work can wait one more hour.",
      "Let the others sweat. I have the shade.",
    ],
    hardworking: [
      "Two more loads before I rest.",
      "The wood will not split itself.",
    ],
    fearful: [
      "Strange how the wind sounds tonight.",
      "I should not have stayed out so late.",
    ],
    brave: [
      "Let trouble come. I have stood worse.",
      "Better to face the wolf than cower from the shadow.",
    ],
    cynical: [
      "Every promise rots eventually. Even the King's.",
      "Faith? Faith is a tax on the gullible.",
    ],
    generous: [
      "I should bring an extra loaf for old Mira tomorrow.",
      "Coin is heaviest when you have too much of it.",
    ],
    arrested: [
      "These iron bars are cold against the back.",
      "I should not have done it. But I did.",
    ],
    drinking: [
      "One more cup, then home. Truly.",
      "The tavern is the only honest court.",
    ],
    working: [
      "Steady hands. Steady work.",
      "Another day, another small piece of the kingdom.",
    ],
    resting: [
      "The hearth is enough tonight.",
      "Sleep, then begin again.",
    ],
    default: [
      "Just another day under the open sky.",
      "I wonder what the rest of the world looks like.",
      "The fields are quiet today.",
    ],
  };
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function pickThought(c) {
    if (c.state === "JAIL" || c.state === "ARREST") return pick(THOUGHTS.arrested);
    if (c.griefUntilDay > 0 && State.time.totalDays < c.griefUntilDay) return pick(THOUGHTS.grieving);
    if (c.tier === 4) return pick(THOUGHTS.king);
    if (c.tier === 5) return pick(THOUGHTS.queen);
    if (State.time.totalDays < c.blessUntilDay) return pick(THOUGHTS.blessed);
    if (State.time.totalDays < c.feardUntilDay) return pick(THOUGHTS.feared);
    if (c.hunger < 30) return pick(THOUGHTS.hungry);
    if (c.sickness > 40) return pick(THOUGHTS.sick);
    if (c.state === "DRINK") return pick(THOUGHTS.drinking);
    if (c.state === "REST") return pick(THOUGHTS.resting);
    if (c.tier === 3) return pick(THOUGHTS.noble);
    if (c.gold > 150) return pick(THOUGHTS.rich);
    if (c.happiness > 75) return pick(THOUGHTS.joyful);
    // trait-flavored idle thoughts
    const traitKey = c.trait && c.trait.toLowerCase();
    if (traitKey && THOUGHTS[traitKey]) return pick(THOUGHTS[traitKey]);
    if (c.state === "WORK") return pick(THOUGHTS.working);
    return pick(THOUGHTS.default);
  }

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
    camera: { x: 0, y: 0, zoom: 1 },
    cameraDrag: null,
    shake: { until: 0, mag: 0 },
    extinct: false,
    nextId: 1,
    lastBlessUntil: 0,
    rainBoostUntilDay: 0,
    plagueActive: false,
    // Phase 2 / 7 / 8 — living world state
    royalty: { kingId: null, queenId: null, palaceId: null, lastEdictDay: 0, edict: null, founded: false },
    treasury: 0,             // national gold reserve, separate from personal NPC gold
    army: 0,                 // count of RoyalGuard citizens
    awayLog: [],             // {day, text} significant events buffered while sped up
    awayActive: false,       // true while time scale > 1
    lastEventDay: 0,         // for the Living Event Engine cadence
    followId: null,          // citizen id the camera is following
    dashboardOpen: false,
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

    // PHASE 1 spec — camera mathematically centres on the exact middle
    // tile of the 24×24 grid on first load. Middle tile is (GRID/2, GRID/2).
    State.camera.zoom = 1;
    const midIso = isoToScreen(GRID_COLS / 2, GRID_ROWS / 2);
    State.camera.x = window.innerWidth / 2 - midIso.x * State.camera.zoom;
    State.camera.y = window.innerHeight / 2 - midIso.y * State.camera.zoom;
  }

  function spawnCitizen({ home, role, gender, age, parents, tier }) {
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
      feardUntilDay: 0,
      dissolveAt: 0,
      // Phase 2 — living soul
      tier: tier || ROLE_TIER[role] || 1,
      trait: TRAITS[Math.floor(Math.random() * TRAITS.length)],
      thought: "",
      partnerId: null,
      childIds: [],
      parentIds: parents ? parents.map((p) => p.id) : [],
      friendIds: [],
      interactions: {},        // { otherId: count } for partnership thresholding
      memory: [],              // last 5 life events
      lastSocialDay: 0,
      lastThoughtDay: -1,
      griefUntilDay: 0,
      isElder: false,
      followGroupId: null,     // for Royal Guards trailing the King
      formationSlot: -1,       // 0..3 cardinal index for guard formation
    };
    State.citizens.push(c);
    if (parents && parents.length) {
      for (const p of parents) {
        if (!p.childIds.includes(c.id)) p.childIds.push(c.id);
        addMemory(p, `${c.name} was born — Year ${State.time.year}.`);
      }
    }
    addMemory(c, `Born in Year ${State.time.year}.`);
    return c;
  }

  function addMemory(c, text) {
    c.memory.push({ day: State.time.totalDays, year: State.time.year, text });
    if (c.memory.length > 5) c.memory.shift();
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

    // Phase 2 — social life: random pairs of adjacent adults bond
    tickSocial();

    // Phase 7 — Royal succession + Royal Guard formation
    tickRoyalty();
    tickRoyalGuards();

    // Phase 8 — Living Event Engine fires every 10 in-game days
    if (State.time.totalDays - State.lastEventDay >= 10) {
      State.lastEventDay = State.time.totalDays;
      rollLivingEvent();
    }

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

    // Elder = oldest living adult (separate from royalty)
    const livingAdults = State.citizens.filter((c) => c.state !== "DEAD" && c.age >= 18);
    const currentElder = livingAdults.find((c) => c.isElder);
    if (!currentElder && livingAdults.length > 0) {
      livingAdults.sort((a, b) => b.age - a.age);
      const heir = livingAdults[0];
      heir.isElder = true;
      if (State.time.totalDays > 1) {
        pushNotif(`${heir.name} is now Elder of the village.`, "divine");
        addAway(`${heir.name} became Elder of the village.`);
      }
    }

    // Tier promotion / demotion — checked once per Season (day 1 of season)
    if (State.time.day === 1) checkTierMobility();

    // Update army count from RoyalGuard role
    State.army = State.citizens.filter((c) => c.role === "RoyalGuard" && c.state !== "DEAD").length;

    // Extinction check
    if (State.citizens.length === 0 && !State.extinct) triggerExtinction();
  }

  // ---------------- TIER MOBILITY ----------------
  function checkTierMobility() {
    for (const c of State.citizens) {
      if (c.state === "DEAD" || c.tier >= 4) continue;
      // Promote
      if (c.tier < 3) {
        const need = TIER_PROMOTE_GOLD[c.tier];
        if (need && c.gold >= need && c.home) {
          c.tier++;
          if (c.tier === 2 && c.role !== "Merchant" && c.role !== "Priest") c.role = "Merchant";
          if (c.tier === 3) c.role = "Noble";
          pushNotif(`${c.name} has risen to ${TIER_BADGE[c.tier]}.`, "divine");
          addAway(`${c.name} rose to ${TIER_BADGE[c.tier]}.`);
          addMemory(c, `Rose to ${TIER_BADGE[c.tier]} — Year ${State.time.year}.`);
        }
      }
      // Demote
      if (c.tier > 1) {
        const floor = TIER_DEMOTE_GOLD[c.tier];
        if (floor && c.gold < floor) {
          c.tier--;
          pushNotif(`${c.name} fell to ${TIER_BADGE[c.tier]}.`, "danger");
          addAway(`${c.name} fell to ${TIER_BADGE[c.tier]}.`);
          addMemory(c, `Fell to ${TIER_BADGE[c.tier]} — Year ${State.time.year}.`);
        }
      }
    }
  }

  // ---------------- SOCIAL — friendship & partnership formation ----------------
  function tickSocial() {
    const adults = State.citizens.filter((c) => c.state !== "DEAD" && c.age >= 18 && c.happiness > 40 && c.state !== "WORK");
    if (adults.length < 2) return;
    // Per tick, one adult (rotating by day) tries to interact with a nearby adult
    const a = adults[State.time.totalDays % adults.length];
    const candidates = adults.filter((b) => b !== a && Math.abs(b.row - a.row) + Math.abs(b.col - a.col) <= 2);
    if (!candidates.length) return;
    const b = candidates[Math.floor(Math.random() * candidates.length)];
    // Track positive interaction
    a.interactions[b.id] = (a.interactions[b.id] || 0) + 1;
    b.interactions[a.id] = (b.interactions[a.id] || 0) + 1;
    a.happiness = Math.min(100, a.happiness + 1);
    b.happiness = Math.min(100, b.happiness + 1);
    a.lastSocialDay = b.lastSocialDay = State.time.totalDays;
    // Friendship after 3 interactions
    if (a.interactions[b.id] === 3) {
      if (!a.friendIds.includes(b.id)) a.friendIds.push(b.id);
      if (!b.friendIds.includes(a.id)) b.friendIds.push(a.id);
    }
    // Partnership after 6+ interactions, both unattached, both 18+
    if (a.interactions[b.id] >= 6 && !a.partnerId && !b.partnerId && a.id !== b.id) {
      a.partnerId = b.id;
      b.partnerId = a.id;
      addMemory(a, `Married ${b.name} — Year ${State.time.year}.`);
      addMemory(b, `Married ${a.name} — Year ${State.time.year}.`);
      pushNotif(`${a.name} and ${b.name} were wed today.`, "good");
      addAway(`${a.name} and ${b.name} were wed.`);
    }
  }

  // ---------------- ROYALTY — King, Queen, Palace, Guards ----------------
  function tickRoyalty() {
    // Crown a King at Year 5 if none exists
    const kingAlive = State.royalty.kingId && State.citizens.some((c) => c.id === State.royalty.kingId && c.state !== "DEAD");
    if (!kingAlive && State.time.year >= 5 && State.citizens.length > 0) {
      crownNewKing();
    }
    // If Queen died/left, find a partner of the King
    if (State.royalty.kingId) {
      const king = State.citizens.find((c) => c.id === State.royalty.kingId);
      const queenAlive = State.royalty.queenId && State.citizens.some((c) => c.id === State.royalty.queenId && c.state !== "DEAD");
      if (king && !queenAlive && king.partnerId) {
        const q = State.citizens.find((c) => c.id === king.partnerId && c.state !== "DEAD" && c.gender === "F");
        if (q) {
          q.tier = 5; q.role = "Queen";
          State.royalty.queenId = q.id;
          addMemory(q, `Crowned Queen — Year ${State.time.year}.`);
          pushNotif(`✨ ${q.name} has been crowned Queen.`, "divine");
          addAway(`${q.name} was crowned Queen.`);
        }
      }
    }
  }
  function crownNewKing() {
    // Highest gold, prefer existing Noble (tier 3), else any adult male
    let pool = State.citizens.filter((c) => c.state !== "DEAD" && c.age >= 18);
    if (!pool.length) return;
    const nobles = pool.filter((c) => c.tier === 3);
    if (nobles.length) pool = nobles;
    pool.sort((a, b) => b.gold - a.gold);
    const king = pool[0];
    king.tier = 4; king.role = "King"; king.gender = "M";
    State.royalty.kingId = king.id;
    State.royalty.founded = true;
    addMemory(king, `Crowned King — Year ${State.time.year}.`);
    pushNotif(`👑 ${king.name} has been crowned King of the realm.`, "divine");
    addAway(`${king.name} was crowned King.`);
    // Spawn the Royal Palace at the world centre if there isn't one
    if (!State.royalty.palaceId) {
      const cr = Math.floor(GRID_ROWS / 2), cc = Math.floor(GRID_COLS / 2);
      let pr = cr, pc = cc;
      // search outward for a free grass tile
      for (let radius = 0; radius < 6 && State.buildings.some((b) => b.row === pr && b.col === pc); radius++) {
        for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
          const r = cr + dr, c = cc + dc;
          if (!inBounds(r, c)) continue;
          if (State.tiles[r][c].type !== "grass") continue;
          if (State.buildings.some((b) => b.row === r && b.col === c)) continue;
          pr = r; pc = c; break;
        }
      }
      const palace = { id: newId(), kind: "palace", row: pr, col: pc, level: 1, smokePhase: 0, sway: 0 };
      State.buildings.push(palace);
      State.royalty.palaceId = palace.id;
      // Move king home to palace
      king.home = { row: pr, col: pc, id: palace.id };
      king.row = pr; king.col = pc; king.vrow = pr; king.vcol = pc;
    }
    // Spawn 4 Royal Guards as Tier 4 retinue
    const palace = State.buildings.find((b) => b.id === State.royalty.palaceId);
    for (let i = 0; i < 4; i++) {
      const guard = spawnCitizen({ home: palace, role: "RoyalGuard", gender: i % 2 === 0 ? "M" : "F", age: 22 + Math.floor(Math.random() * 18) });
      guard.tier = 4;
      guard.followGroupId = king.id;
      guard.formationSlot = i;
      guard.health = 100;
      addMemory(guard, `Sworn to the King — Year ${State.time.year}.`);
    }
  }
  function tickRoyalGuards() {
    if (!State.royalty.kingId) return;
    const king = State.citizens.find((c) => c.id === State.royalty.kingId);
    if (!king || king.state === "DEAD") return;
    // 4 cardinal slots: N(-1,0) E(0,+1) S(+1,0) W(0,-1)
    const slots = [[-1, 0], [0, 1], [1, 0], [0, -1]];
    const guards = State.citizens.filter((c) => c.followGroupId === king.id && c.state !== "DEAD");
    for (const g of guards) {
      const slot = slots[g.formationSlot % 4];
      const tr = Math.max(0, Math.min(GRID_ROWS - 1, king.row + slot[0]));
      const tc = Math.max(0, Math.min(GRID_COLS - 1, king.col + slot[1]));
      // Force the guard to step toward the slot every tick — overrides default work
      if (g.row !== tr || g.col !== tc) {
        g.row = tr; g.col = tc;
        g.state = "WALK";
      } else {
        g.state = "IDLE";
      }
    }
  }

  // ---------------- LIVING EVENT ENGINE ----------------
  function rollLivingEvent() {
    const events = [
      { weight: 3, fire: () => {
        // A Merchant becomes the richest
        const m = State.citizens.filter((c) => c.role === "Merchant" && c.state !== "DEAD").sort((a, b) => b.gold - a.gold)[0];
        if (m) { pushNotif(`💰 ${m.name} is now the wealthiest merchant in the realm.`, "good"); addAway(`${m.name} became the realm's wealthiest merchant.`); }
      }},
      { weight: 2, fire: () => {
        State.resources.food += 50; State.resources.gold += 20;
        pushNotif("⚓ A trade caravan arrived. +50 Food, +20 Gold.", "good");
        addAway("A trade caravan arrived (+50 Food, +20 Gold).");
      }},
      { weight: 2, fire: () => {
        const c = State.citizens.filter((x) => x.tier <= 2 && x.state !== "DEAD")[0];
        if (c) { pushNotif(`A whisper spreads: ${c.name} has been seen reading by candlelight.`, "good"); }
      }},
      { weight: 2, fire: () => {
        State.resources.food = Math.max(0, State.resources.food - 30);
        pushNotif("🌧 A poor harvest this season. -30 Food.", "danger");
        addAway("A poor harvest cost 30 Food.");
      }},
      { weight: 1, fire: () => {
        const noble = State.citizens.find((c) => c.tier === 3 && c.state !== "DEAD");
        if (noble) { noble.gold += 30; pushNotif(`A Noble (${noble.name}) is hoarding gold. +30 to their purse.`, "danger"); addAway(`${noble.name} hoarded gold.`); }
      }},
      { weight: 1, fire: () => {
        const k = State.royalty.kingId && State.citizens.find((c) => c.id === State.royalty.kingId);
        if (k) {
          const edicts = ["Tax Harvest", "Guild Charter", "Festival of Light", "Conscription"];
          const e = edicts[Math.floor(Math.random() * edicts.length)];
          State.royalty.edict = e; State.royalty.lastEdictDay = State.time.totalDays;
          pushNotif(`📜 The King issued an edict: "${e}".`, "divine");
          addAway(`King ${k.name} issued the edict "${e}".`);
        }
      }},
      { weight: 1, fire: () => {
        // Twins!
        const mom = State.citizens.filter((c) => c.gender === "F" && c.age >= 18 && c.age < 45 && c.state !== "DEAD" && c.home)[0];
        if (mom) {
          const home = State.buildings.find((b) => b.id === mom.home.id);
          if (home && State.citizens.length < 60) {
            const t1 = spawnCitizen({ home, role: pickChildRole(), gender: "M", age: 0, parents: [mom] });
            const t2 = spawnCitizen({ home, role: pickChildRole(), gender: "F", age: 0, parents: [mom] });
            pushNotif(`✨ Twins were born to ${mom.name}: ${t1.name} and ${t2.name}.`, "good");
            addAway(`Twins were born to ${mom.name}.`);
          }
        }
      }},
      { weight: 1, fire: () => {
        // Pick an actual Royal Guard and remove them — otherwise the count snaps back next tick
        const guards = State.citizens.filter((g) => g.role === "RoyalGuard" && g.state !== "DEAD");
        if (guards.length) {
          const deserter = guards[Math.floor(Math.random() * guards.length)];
          deserter.role = "Farmer";
          deserter.tier = 1;
          deserter.followGroupId = null;
          deserter.formationSlot = -1;
          deserter.happiness = Math.max(0, deserter.happiness - 20);
          addMemory(deserter, `Deserted the Royal Guard — Year ${State.time.year}.`);
          pushNotif(`⚔ ${deserter.name} deserted the Royal Guard.`, "danger");
          addAway(`${deserter.name} deserted the Royal Guard.`);
        }
      }},
    ];
    const total = events.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of events) { if ((r -= e.weight) <= 0) { e.fire(); return; } }
  }

  // ---------------- "YOU WERE AWAY" RECAP ----------------
  function addAway(text) {
    if (!State.awayActive) return;
    State.awayLog.push({ day: State.time.totalDays, year: State.time.year, text });
    if (State.awayLog.length > 12) State.awayLog.shift();
  }
  function flushAwayRecap() {
    if (!State.awayLog.length) return;
    const modal = document.getElementById("away-modal");
    const list = document.getElementById("away-list");
    list.innerHTML = State.awayLog.map((e) => `<li>Year ${e.year} · ${e.text}</li>`).join("");
    modal.classList.add("show");
    State.awayLog = [];
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
    if (State.time.totalDays < c.griefUntilDay) c.mood = "Grieving";
    else if (c.sickness > 40) c.mood = "Sick";
    else if (c.hunger < 25) c.mood = "Hungry";
    else if (c.happiness < 25) c.mood = "Angry";
    else if (c.happiness < 50) c.mood = "Anxious";
    else if (c.happiness > 80) c.mood = "Joyful";
    else c.mood = "Content";

    // Refresh thought every few in-game days, or whenever big state changes
    if (State.time.totalDays - c.lastThoughtDay >= 3) {
      c.thought = pickThought(c);
      c.lastThoughtDay = State.time.totalDays;
    }

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
    // Father = mother's partner if any, else any male sharing the home, else random male
    let father = mother.partnerId ? males.find((m) => m.id === mother.partnerId) : null;
    if (!father) father = males.find((m) => m.home && m.home.id === mother.home.id);
    if (!father) father = males[Math.floor(Math.random() * males.length)];
    const parents = father ? [mother, father] : [mother];
    const baby = spawnCitizen({ home, role: pickChildRole(), gender: Math.random() < 0.5 ? "M" : "F", age: 0, parents });
    baby.state = "IDLE";
    pushNotif(`${baby.name} was born to ${mother.name}${father ? ` and ${father.name}` : ""}.`, "good");
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
    addAway(`${c.name} (${c.role}) died of ${cause}, aged ${c.age}.`);
    // Grief on partner
    if (c.partnerId) {
      const partner = State.citizens.find((o) => o.id === c.partnerId && o.state !== "DEAD");
      if (partner) {
        partner.griefUntilDay = State.time.totalDays + 10;
        partner.happiness = Math.max(0, partner.happiness - 30);
        partner.mood = "Grieving";
        partner.partnerId = null;
        addMemory(partner, `Lost ${c.name} to ${cause} — Year ${State.time.year}.`);
        pushNotif(`${partner.name} grieves the loss of ${c.name}.`, "danger");
      }
    }
    // Inherit gold to children, split equally
    if (c.childIds && c.childIds.length && c.gold > 0) {
      const heirs = c.childIds.map((id) => State.citizens.find((o) => o.id === id && o.state !== "DEAD")).filter(Boolean);
      if (heirs.length) {
        const share = Math.floor(c.gold / heirs.length);
        for (const h of heirs) {
          h.gold += share;
          addMemory(h, `Inherited ${share} gold from ${c.name}.`);
        }
      }
    }
    // Royal succession on King's death
    if (c.id === State.royalty.kingId) {
      State.royalty.kingId = null;
      pushNotif(`👑 The King has died. The realm trembles.`, "danger");
      addAway(`King ${c.name} died.`);
      // Eldest child of the King → heir; else next call to tickRoyalty will crown a new noble
      const heir = c.childIds.map((id) => State.citizens.find((o) => o.id === id && o.state !== "DEAD" && o.age >= 18)).filter(Boolean)[0];
      if (heir) {
        heir.tier = 4; heir.role = "King"; heir.gender = "M";
        State.royalty.kingId = heir.id;
        // re-bind royal guards
        for (const g of State.citizens.filter((g) => g.followGroupId === c.id)) g.followGroupId = heir.id;
        pushNotif(`👑 ${heir.name} ascends the throne. Long live the King.`, "divine");
        addAway(`${heir.name} ascended the throne.`);
        addMemory(heir, `Crowned King — Year ${State.time.year}.`);
      } else {
        // Instability
        State.resources.faith = Math.max(0, State.resources.faith - 30);
        for (const o of State.citizens) o.happiness = Math.max(0, o.happiness - 20);
        pushNotif("⚠ No heir. The realm enters instability. -20 happiness, -30 faith.", "danger");
      }
    }
    if (c.id === State.royalty.queenId) {
      State.royalty.queenId = null;
      pushNotif(`The Queen has died. Faith falters.`, "danger");
      State.resources.faith = Math.max(0, State.resources.faith - 15);
    }
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
        // If anyone lives here, treat them as parents
        const residents = State.citizens.filter((c) => c.home && c.home.id === home.id && c.state !== "DEAD" && c.age >= 18);
        const baby = spawnCitizen({ home, role: pickChildRole(), gender: Math.random() < 0.5 ? "M" : "F", age: 0, parents: residents.length ? residents.slice(0, 2) : undefined });
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
    // emit weather particles per frame — pure screen-space coords now
    const W = window.innerWidth;
    if (SEASONS[State.time.season] === "Autumn") {
      if (Math.random() < 0.4) {
        State.particles.push({
          kind: "leaf",
          x: Math.random() * W,
          y: Math.random() * 40,
          vx: 0.3 + Math.random() * 0.3, vy: 0.2 + Math.random() * 0.3,
          life: 6000, born: now, rot: Math.random() * Math.PI * 2,
        });
      }
    }
    if (SEASONS[State.time.season] === "Winter" || State.weather === "Storm") {
      if (Math.random() < 0.7) {
        State.particles.push({
          kind: "snow",
          x: Math.random() * W,
          y: Math.random() * 40,
          vx: -0.05 + Math.random() * 0.1, vy: 0.4 + Math.random() * 0.3,
          life: 5000, born: now, r: 1.5 + Math.random() * 1.5,
        });
      }
    }
    if (State.weather === "Rain" || State.weather === "Storm") {
      if (Math.random() < 1.0) {
        State.particles.push({
          kind: "rain",
          x: Math.random() * W,
          y: Math.random() * 40,
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

    // Camera + shake — PHASE 1: pan + zoom passed through the canvas
    // transform. This is the equivalent of:
    //   screenX = (col-row) * TILE_W/2 * camera.zoom + camera.x
    //   screenY = (col+row) * TILE_H/2 * camera.zoom + camera.y
    // for every world-space coordinate produced by isoToScreen().
    let shakeX = 0, shakeY = 0;
    if (now < State.shake.until) {
      shakeX = (Math.random() - 0.5) * State.shake.mag;
      shakeY = (Math.random() - 0.5) * State.shake.mag;
    }
    ctx.save();
    ctx.translate(State.camera.x + shakeX, State.camera.y + shakeY);
    ctx.scale(State.camera.zoom, State.camera.zoom);

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
    // These live in pure screen-space — no camera/zoom applied — so weather
    // rolls across the viewport at constant density regardless of zoom level.
    drawScreenParticles(now);

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
    // Body — tier-tinted tunic (tier overrides plain role color for nobility/royalty)
    let bodyColor;
    if (c.age < 12) bodyColor = ROLE_COLORS.Child;
    else if (c.tier >= 3) bodyColor = TIER_TINTS[c.tier];
    else bodyColor = (ROLE_COLORS[c.role] || TIER_TINTS[c.tier] || "#7a8090");
    if (c.state === "JAIL") ctx.fillStyle = "#3a3a44"; else ctx.fillStyle = bodyColor;
    ctx.fillRect(cx - 6, cy, 12, 16);
    // Tier-3 nobles get a gold-trim collar
    if (c.tier === 3) {
      ctx.fillStyle = "#d4af6a";
      ctx.fillRect(cx - 6, cy, 12, 2);
    }
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
    // Crowns — King/Queen take precedence over Elder
    if (c.tier === 4) {
      // Tall gold king's crown
      ctx.fillStyle = "#f5d27a";
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 8);
      ctx.lineTo(cx - 6, cy - 13);
      ctx.lineTo(cx - 3, cy - 10);
      ctx.lineTo(cx, cy - 14);
      ctx.lineTo(cx + 3, cy - 10);
      ctx.lineTo(cx + 6, cy - 13);
      ctx.lineTo(cx + 6, cy - 8);
      ctx.closePath();
      ctx.fill();
      // crown jewel
      ctx.fillStyle = "#c25a4a";
      ctx.fillRect(cx - 1, cy - 12, 2, 2);
    } else if (c.tier === 5) {
      // Slimmer silver queen's tiara
      ctx.fillStyle = "#e6e6f0";
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - 9);
      ctx.lineTo(cx - 2, cy - 12);
      ctx.lineTo(cx + 2, cy - 12);
      ctx.lineTo(cx + 5, cy - 9);
      ctx.closePath();
      ctx.fill();
    } else if (c.role === "RoyalGuard") {
      // Red-plumed helm
      ctx.fillStyle = "#9a3a32";
      ctx.fillRect(cx - 4, cy - 11, 8, 3);
      ctx.fillStyle = "#c25a4a";
      ctx.fillRect(cx - 1, cy - 14, 2, 4);
    } else if (c.isElder) {
      // Elder cap (small gold)
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
    // Speech bubble when socializing this tick
    if (State.time.totalDays - c.lastSocialDay < 1 && c.state !== "WORK" && c.state !== "JAIL") {
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      ctx.beginPath(); ctx.arc(cx + 8, cy - 12, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#3a3028";
      ctx.fillRect(cx + 6, cy - 12.5, 4, 1);
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
    const partner = c.partnerId ? State.citizens.find((o) => o.id === c.partnerId) : null;
    const children = (c.childIds || []).map((id) => State.citizens.find((o) => o.id === id)).filter(Boolean);
    const friends = (c.friendIds || []).map((id) => State.citizens.find((o) => o.id === id)).filter(Boolean);
    const tierBadge = TIER_BADGE[c.tier] || "Labourer";
    const titlePrefix = c.tier === 4 ? "King " : c.tier === 5 ? "Queen " : c.tier === 3 ? (c.gender === "F" ? "Lady " : "Lord ") : "";
    const memHtml = c.memory.length
      ? c.memory.slice().reverse().map((m) => `<li>Year ${m.year} · ${m.text}</li>`).join("")
      : `<li class="dim">No notable memories yet.</li>`;
    const linkPerson = (p) => `<span class="person-link" data-cid="${p.id}">${p.name}${p.state === "DEAD" ? " †" : ""}</span>`;
    const followBtn = State.followId === c.id ? "Stop Following" : "Follow";
    ip.innerHTML = `
      <span class="close" data-close>×</span>
      <h3>${titlePrefix}${c.name}${c.isElder && c.tier < 3 ? " 👑" : ""}</h3>
      <div class="sub">${tierBadge} · ${c.gender === "F" ? "Lady" : "Lord"} · Age ${c.age} · ${c.role}</div>
      <div class="thought">"${c.thought || pickThought(c)}"</div>
      <div class="badges">
        <span class="badge tier-${c.tier}">${tierBadge}</span>
        <span class="badge">${c.trait}</span>
        <span class="badge mood-${c.mood.toLowerCase()}">${c.mood}</span>
      </div>
      ${bar("Hunger", c.hunger)}
      ${bar("Health", c.health)}
      ${bar("Happiness", c.happiness)}
      <div class="row"><span class="lbl">Gold</span><span class="val">${c.gold} 💰</span></div>
      <div class="row"><span class="lbl">State</span><span class="val">${c.state}</span></div>
      ${c.sickness > 0 ? bar("Sickness", c.sickness) : ""}
      <div class="section-title">Relationships</div>
      <div class="rels">
        ${partner ? `<div><span class="lbl">Partner:</span> ${linkPerson(partner)}</div>` : `<div class="dim">No partner.</div>`}
        ${children.length ? `<div><span class="lbl">Children:</span> ${children.map(linkPerson).join(", ")}</div>` : ""}
        ${friends.length ? `<div><span class="lbl">Friends:</span> ${friends.map(linkPerson).join(", ")}</div>` : ""}
      </div>
      <div class="section-title">Memory</div>
      <ul class="memory">${memHtml}</ul>
      <button class="follow-btn" data-follow>${followBtn}</button>
    `;
    showInspect();
    ip.querySelector("[data-close]").onclick = () => { State.selected = null; State.followId = null; hideInspect(); };
    ip.querySelector("[data-follow]").onclick = () => {
      if (State.followId === c.id) State.followId = null;
      else State.followId = c.id;
      renderInspectCitizen(c);
    };
    ip.querySelectorAll(".person-link").forEach((el) => {
      el.onclick = () => {
        const id = parseInt(el.dataset.cid, 10);
        const ref = State.citizens.find((o) => o.id === id);
        if (ref) { State.selected = { kind: "citizen", ref }; renderInspectCitizen(ref); }
      };
    });
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
      // click-to-target / inspect — convert screen pixel into WORLD-space
      // coords (inverse of the render transform: subtract camera, divide by zoom)
      const wx = (e.clientX - State.camera.x) / State.camera.zoom;
      const wy = (e.clientY - State.camera.y) / State.camera.zoom;
      handleWorldClick(wx, wy, e.clientX, e.clientY);
    });

    // PHASE 1 spec — mouse wheel zoom, clamped 0.5×–2.0×, centred on cursor
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const oldZoom = State.camera.zoom;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.max(0.5, Math.min(2.0, oldZoom * factor));
      if (newZoom === oldZoom) return;
      // Anchor: keep the world point under the cursor stationary
      const wx = (e.clientX - State.camera.x) / oldZoom;
      const wy = (e.clientY - State.camera.y) / oldZoom;
      State.camera.zoom = newZoom;
      State.camera.x = e.clientX - wx * newZoom;
      State.camera.y = e.clientY - wy * newZoom;
    }, { passive: false });

    document.querySelectorAll(".tc-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        const wasFastForward = State.time.scale > 1 || State.awayActive;
        if (cmd === "pause") State.time.paused = true;
        else if (cmd === "play") { State.time.paused = false; State.time.scale = 1; }
        else if (cmd === "x5") { State.time.paused = false; State.time.scale = 5; }
        else if (cmd === "x20") { State.time.paused = false; State.time.scale = 20; }
        else if (cmd === "sleep") {
          // fast-forward to next season boundary — count as away time
          State.awayActive = true;
          const daysLeft = SEASON_DAYS - State.time.day + 1;
          for (let i = 0; i < daysLeft; i++) tickDay();
          State.awayActive = false;
          flushAwayRecap();
          return;
        }
        // Activate / deactivate away tracking
        State.awayActive = State.time.scale > 1;
        if (wasFastForward && cmd === "play") flushAwayRecap();
      });
    });

    // Kingdom Dashboard — toggle with K
    document.getElementById("dashboard-close").addEventListener("click", () => {
      document.getElementById("dashboard").classList.remove("show");
      State.dashboardOpen = false;
    });
    document.getElementById("away-close").addEventListener("click", () => {
      document.getElementById("away-modal").classList.remove("show");
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
      const wasFastForward = State.time.scale > 1 || State.awayActive;
      const setScale = (s) => {
        State.time.paused = false;
        State.time.scale = s;
        State.awayActive = s > 1;
        if (s === 1 && wasFastForward) flushAwayRecap();
      };
      if (e.key === " ") { e.preventDefault(); State.time.paused = !State.time.paused; }
      else if (e.key === "1") { setScale(1); }
      else if (e.key === "2") { setScale(5); }
      else if (e.key === "3") { setScale(20); }
      else if (e.key === "Escape") {
        State.activePower = null; canvas.classList.remove("targeting");
        State.selected = null; State.followId = null;
        hideInspect();
        document.getElementById("dashboard").classList.remove("show");
        document.getElementById("away-modal").classList.remove("show");
        State.dashboardOpen = false;
      }
      else if (e.key === "k" || e.key === "K") {
        State.dashboardOpen = !State.dashboardOpen;
        const dash = document.getElementById("dashboard");
        if (State.dashboardOpen) { renderDashboard(); dash.classList.add("show"); }
        else dash.classList.remove("show");
      }
    });
  }

  function renderDashboard() {
    const root = document.getElementById("dashboard-body");
    const tierCounts = [0, 0, 0, 0, 0, 0];
    let totalGold = 0, totalHappy = 0, sickCount = 0, criminalCount = 0;
    for (const c of State.citizens) {
      if (c.state === "DEAD") continue;
      tierCounts[c.tier] = (tierCounts[c.tier] || 0) + 1;
      totalGold += c.gold;
      totalHappy += c.happiness;
      if (c.sickness > 40) sickCount++;
      if (c.crimeStreak > 6) criminalCount++;
    }
    const living = State.citizens.filter((c) => c.state !== "DEAD").length;
    const avgHappy = living ? Math.floor(totalHappy / living) : 0;
    const king = State.royalty.kingId && State.citizens.find((c) => c.id === State.royalty.kingId);
    const queen = State.royalty.queenId && State.citizens.find((c) => c.id === State.royalty.queenId);
    const trafficLight = (n, warn, danger) => n >= danger ? "red" : n >= warn ? "amber" : "green";
    root.innerHTML = `
      <div class="dash-grid">
        <div class="dash-card">
          <div class="dash-label">Population</div>
          <div class="dash-big">${living}</div>
          <div class="dash-tiers">
            ${[1,2,3,4,5].map((t) => `<div class="dash-tier"><span class="tier-dot tier-${t}"></span>${TIER_BADGE[t]}: <b>${tierCounts[t] || 0}</b></div>`).join("")}
          </div>
        </div>
        <div class="dash-card">
          <div class="dash-label">Economy</div>
          <div class="dash-row"><span>Treasury</span><b>${State.treasury} 💰</b></div>
          <div class="dash-row"><span>Personal Gold (sum)</span><b>${totalGold} 💰</b></div>
          <div class="dash-row"><span>Food</span><b>${Math.floor(State.resources.food)} 🌾</b></div>
          <div class="dash-row"><span>Wood / Stone</span><b>${Math.floor(State.resources.wood)} / ${Math.floor(State.resources.stone)}</b></div>
        </div>
        <div class="dash-card">
          <div class="dash-label">Crown</div>
          ${king ? `<div class="dash-row"><span>King</span><b>${king.name}, ${king.age}</b></div>` : `<div class="dash-row dim">No King has yet been crowned.</div>`}
          ${queen ? `<div class="dash-row"><span>Queen</span><b>${queen.name}, ${queen.age}</b></div>` : ""}
          <div class="dash-row"><span>Royal Guard</span><b>${State.army} ⚔</b></div>
          ${State.royalty.edict ? `<div class="dash-row"><span>Active Edict</span><b>${State.royalty.edict}</b></div>` : ""}
        </div>
        <div class="dash-card">
          <div class="dash-label">Wellbeing</div>
          <div class="dash-row"><span>Average Happiness</span><b>${avgHappy}</b></div>
          <div class="dash-row"><span>Faith</span><b>${Math.floor(State.resources.faith)} ✨</b></div>
          <div class="dash-row"><span>Disease</span><span class="light light-${trafficLight(sickCount, 1, 3)}"></span> <b>${sickCount}</b></div>
          <div class="dash-row"><span>Crime</span><span class="light light-${trafficLight(criminalCount, 1, 3)}"></span> <b>${criminalCount}</b></div>
          <div class="dash-row"><span>Revolt risk</span><span class="light light-${avgHappy < 15 ? "red" : avgHappy < 35 ? "amber" : "green"}"></span></div>
        </div>
      </div>
    `;
  }

  function handleWorldClick(wx, wy /*, screenX, screenY */) {
    const { col, row } = screenToIso(wx, wy);
    const r = Math.round(row), c = Math.round(col);
    if (!inBounds(r, c)) return;

    if (State.activePower) {
      const target = { row: r, col: c };
      castPower(State.activePower, target);
      State.activePower = null;
      canvas.classList.remove("targeting");
      return;
    }

    // Pick citizen first (closest in WORLD space, threshold scaled to zoom)
    const pickRadius = 22 / State.camera.zoom;
    let bestCit = null, bestD = Infinity;
    for (const ct of State.citizens) {
      const iso = isoToScreen(ct.vcol, ct.vrow);
      const dx = iso.x - wx, dy = (iso.y - 28) - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < pickRadius && d < bestD) { bestD = d; bestCit = ct; }
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

    // Follow camera — gently track the followed citizen
    if (State.followId) {
      const tgt = State.citizens.find((c) => c.id === State.followId && c.state !== "DEAD");
      if (tgt) {
        const iso = isoToScreen(tgt.vcol, tgt.vrow);
        const desiredX = window.innerWidth / 2 - iso.x * State.camera.zoom;
        const desiredY = window.innerHeight / 2 - iso.y * State.camera.zoom;
        State.camera.x += (desiredX - State.camera.x) * 0.08;
        State.camera.y += (desiredY - State.camera.y) * 0.08;
      } else {
        State.followId = null;
      }
    }

    tickParticles(dt);
    render();
    updateHUD();
    if (State.dashboardOpen) renderDashboard();

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
