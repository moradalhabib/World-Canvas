import type { BuildingDef, BuildingId } from "./types";

/**
 * Building catalog — defines the entire economy and supply chain.
 *
 * Supply chain summary:
 *   Farm        → wheat
 *   Lumber camp → wood (requires forest neighbor)
 *   Mine        → stone (requires mountain neighbor)
 *   Bakery      → consumes wheat + wood, produces bread
 *   Houses      → consume bread, generate gold (taxes), house population
 *   Well        → service (small social bonus, low desirability impact)
 */
export const BUILDING_DEFS: Record<BuildingId, BuildingDef> = {
  /* ── Residential (Free Tier — slums / wooden huts) ── */
  house_free: {
    id: "house_free",
    name: "Hut",
    category: "residential",
    tier: "free",
    validOn: ["grass", "desert"],
    buildCost: { wood: 5 },
    consumes: { bread: 1 },
    produces: {},
    taxes: 1,
    housing: 4,
    workers: 0,
    desirability: -0.1,
    desirabilityRadius: 2,
    fillColor: "#8b6f4a",
    roofColor: "#5a4530",
    glyph: "h",
    satisfies: { safety: 12, social: 4 },
  },

  /* ── Residential (Middle Tier — stone houses) ── */
  house_middle: {
    id: "house_middle",
    name: "Stone House",
    category: "residential",
    tier: "middle",
    validOn: ["grass", "desert"],
    buildCost: { wood: 8, stone: 6 },
    consumes: { bread: 2 },
    produces: {},
    taxes: 4,
    housing: 6,
    workers: 0,
    desirability: 0.1,
    desirabilityRadius: 3,
    fillColor: "#c9c2b3",
    roofColor: "#6b5848",
    glyph: "H",
    satisfies: { safety: 16, social: 8, vanity: 4 },
  },

  /* ── Residential (High Tier — manors) ── */
  house_high: {
    id: "house_high",
    name: "Manor",
    category: "residential",
    tier: "high",
    validOn: ["grass"],
    buildCost: { wood: 12, stone: 14, gold: 20 },
    consumes: { bread: 3 },
    produces: {},
    taxes: 12,
    housing: 8,
    workers: 0,
    desirability: 0.25,
    desirabilityRadius: 4,
    fillColor: "#f5f1e8",
    roofColor: "#8b1a1a",
    glyph: "M",
    satisfies: { safety: 20, social: 12, vanity: 16, faith: 4 },
  },

  /* ── Production ── */
  farm: {
    id: "farm",
    name: "Farm",
    category: "production",
    tier: "free",
    validOn: ["grass"],
    buildCost: { wood: 6 },
    consumes: {},
    produces: { wheat: 4 },
    taxes: 1,
    housing: 0,
    workers: 2,
    desirability: -0.05,
    desirabilityRadius: 2,
    fillColor: "#d4b86a",
    roofColor: "#8a6a2a",
    glyph: "F",
    satisfies: {},
  },

  bakery: {
    id: "bakery",
    name: "Bakery",
    category: "production",
    tier: "middle",
    validOn: ["grass", "desert"],
    buildCost: { wood: 8, stone: 4 },
    consumes: { wheat: 3, wood: 1 },
    produces: { bread: 4 },
    taxes: 2,
    housing: 0,
    workers: 1,
    desirability: 0.05,
    desirabilityRadius: 3,
    fillColor: "#d8a373",
    roofColor: "#5e3a20",
    glyph: "B",
    satisfies: { hunger: 10 },
  },

  lumber_camp: {
    id: "lumber_camp",
    name: "Lumber Camp",
    category: "production",
    tier: "free",
    validOn: ["grass", "forest"],
    requiredAdjacent: ["forest"],
    buildCost: { wood: 4 },
    consumes: {},
    produces: { wood: 3 },
    taxes: 1,
    housing: 0,
    workers: 2,
    desirability: -0.3,
    desirabilityRadius: 4,
    fillColor: "#6b4a2a",
    roofColor: "#3d2a18",
    glyph: "L",
    satisfies: {},
  },

  mine: {
    id: "mine",
    name: "Mine",
    category: "production",
    tier: "free",
    validOn: ["mountain", "desert"],
    requiredAdjacent: ["mountain"],
    buildCost: { wood: 6, stone: 2 },
    consumes: {},
    produces: { stone: 3 },
    taxes: 2,
    housing: 0,
    workers: 3,
    desirability: -0.5,
    desirabilityRadius: 5,
    fillColor: "#5a5560",
    roofColor: "#2a2630",
    glyph: "X",
    satisfies: {},
  },

  /* ── Service ── */
  well: {
    id: "well",
    name: "Well",
    category: "service",
    tier: "free",
    validOn: ["grass", "desert"],
    buildCost: { stone: 4 },
    consumes: {},
    produces: {},
    taxes: 0,
    housing: 0,
    workers: 0,
    desirability: 0.1,
    desirabilityRadius: 4,
    fillColor: "#7a8a96",
    roofColor: "#4a5560",
    glyph: "w",
    satisfies: { social: 6, faith: 2 },
  },
};

export const ALL_BUILDING_IDS = Object.keys(BUILDING_DEFS) as BuildingId[];

export function getBuildingDef(id: BuildingId): BuildingDef {
  return BUILDING_DEFS[id];
}
