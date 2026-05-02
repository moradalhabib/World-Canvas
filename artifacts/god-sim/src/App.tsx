import { useEffect, useRef, useState, useCallback } from "react";
import { GameEngine } from "./game/GameEngine";
import type { CitizenTapInfo, DivinePower, DivineBrush } from "./game/GameEngine";
import type { ChronicleEntry, Citizen, CivilizationState, GameState } from "./game/types";
import { ALL_NEEDS, NEED_COLORS, NEED_LABELS } from "./game/types";

/**
 * Phase 5: Divine Powers toolbar.
 * Each top-level icon maps to a category; clicking it expands a sub-menu of
 * concrete brushes. The "chronomancer" entries (Freeze, Winter) are toggles
 * that fire once and don't put the canvas into a brush mode.
 */
type ToolbarCategory = "architect" | "judge" | "wrath" | "chronomancer";
interface BrushOpt { id: DivineBrush; label: string; glyph: string; }
const BRUSH_GROUPS: Record<ToolbarCategory, BrushOpt[]> = {
  architect: [
    { id: "paint_grass",    label: "Grass",    glyph: "🌿" },
    { id: "paint_water",    label: "Water",    glyph: "💧" },
    { id: "paint_forest",   label: "Forest",   glyph: "🌲" },
    { id: "paint_mountain", label: "Mountain", glyph: "⛰" },
  ],
  judge: [
    { id: "smite", label: "Smite", glyph: "⚡" },
    { id: "bless", label: "Bless", glyph: "✦" },
  ],
  wrath: [
    { id: "meteor", label: "Meteor", glyph: "☄" },
  ],
  chronomancer: [],
};
const CAT_LABELS: Record<ToolbarCategory, string> = {
  architect: "Architect",
  judge: "Judge",
  wrath: "Wrath",
  chronomancer: "Time",
};
const CAT_GLYPHS: Record<ToolbarCategory, string> = {
  architect: "⚒",
  judge: "⚖",
  wrath: "☄",
  chronomancer: "⏳",
};
const CAT_TO_POWER: Record<ToolbarCategory, DivinePower> = {
  architect: "architect",
  judge: "judge",
  wrath: "wrath",
  chronomancer: "none",
};

/**
 * Phase 4: Generate the inner monologue line for a tapped NPC. The choice is
 * driven by their highest-priority dramatic stat — royalty/faction first,
 * then the survival drives, then profession flavor, with a quiet default.
 */
function buildMonologue(c: Citizen): string {
  if (c.isKing) return "The crown weighs heavy. My subjects must remember their place.";
  if (c.isDowagerQueen) return "I rule until my son is grown. Let no one forget it.";
  if (c.isQueen) return "A queen's smile must never falter, no matter the winter.";
  if (c.isPrince) return "Father trains me for the throne. The day will come.";
  if (c.state === "COMBAT") return "For the realm! Steel meets steel!";
  if (c.faction === "rebel" || c.isRebel)
    return "The true bloodline is broken. We march at dawn.";
  if (c.state === "PRAYING") return "Heavens, deliver us. The bread is gone.";
  if (c.hunger > 80) return "The granaries are empty. We will not survive the winter.";
  if (c.vanity > 80) return "My estates grow larger by the day.";
  if ((c.safety ?? 100) < 30)
    return "I have not slept beneath a roof in weeks.";
  if (c.state === "ROGUE") return "If they will not feed us, we will take what we are owed.";
  if (c.profession === "Guard") return "My watch never ends.";
  if (c.profession === "Farmer") return "The wheat grows tall this year — praise the King.";
  if (c.profession === "Miner") return "Stone for the King's walls — every day, every hour.";
  return "The seasons turn. The work continues.";
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function fmt(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return Math.floor(n).toString();
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const [timeScale, setTimeScaleState] = useState<0 | 1 | 2>(1);
  const [gameMonth, setGameMonth] = useState(1);
  const [gameYear, setGameYear] = useState(1);
  const [civ, setCiv] = useState<CivilizationState | null>(null);
  const [buildingCount, setBuildingCount] = useState(0);
  const [citizenCount, setCitizenCount] = useState(0);
  const [hungryCount, setHungryCount] = useState(0);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [nobleDissent, setNobleDissent] = useState<GameState["nobleDissent"]>("LOW");
  const [dayNight, setDayNight] = useState<GameState["dayNight"]>("day");
  // Phase 13: Climate Engine — surfaced in the top HUD as two small pills.
  const [season, setSeason] = useState<GameState["currentSeason"]>("WINTER");
  const [weather, setWeather] = useState<GameState["currentWeather"]>("CLEAR");
  // Phase 4: Inner Monologue overlay state.
  const [monologue, setMonologue] = useState<{
    citizen: Citizen;
    x: number;
    y: number;
  } | null>(null);
  // Remembered timeScale at the moment the monologue paused the game.
  const prevScaleRef = useRef<0 | 1 | 2>(1);

  // Phase 5: Divine Powers UI state.
  const [openCategory, setOpenCategory] = useState<ToolbarCategory | null>(null);
  // Phase 18: minimize/expand toggles for the side panels so the user
  // can fully hide history and collapse the Needs panel down to a
  // single Hunger bar (the most actionable need).
  const [chronicleMinimized, setChronicleMinimized] = useState(false);
  const [needsExpanded, setNeedsExpanded] = useState(false);
  const [activePower, setActivePower] = useState<DivinePower>("none");
  const [activeBrush, setActiveBrush] = useState<DivineBrush>("none");
  const [winterOn, setWinterOn] = useState(false);
  // Phase 10.5: FPS counter — polled from the engine in its own rAF loop so
  // updates don't reflow the rest of the HUD on every frame.
  const [fps, setFps] = useState<number>(0);

  const onCitizenTap = useCallback((info: CitizenTapInfo) => {
    const eng = engineRef.current;
    if (!eng) return;
    // Phase 5: monologue must NOT open while a divine power is active.
    if (eng.getPower().power !== "none") return;
    prevScaleRef.current = eng.getTimeScale();
    eng.setTimeScale(0);
    setTimeScaleState(0);
    setMonologue({ citizen: info.citizen, x: info.screenX, y: info.screenY });
  }, []);

  // Phase 5: pick a brush. Sets the engine's active power and updates the
  // toolbar highlight. Re-clicking the same brush clears it.
  const selectBrush = useCallback(
    (cat: ToolbarCategory, brush: DivineBrush) => {
      const eng = engineRef.current;
      if (!eng) return;
      if (activePower === CAT_TO_POWER[cat] && activeBrush === brush) {
        eng.clearPower();
        setActivePower("none");
        setActiveBrush("none");
        return;
      }
      const power = CAT_TO_POWER[cat];
      eng.setPower(power, brush);
      setActivePower(power);
      setActiveBrush(brush);
    },
    [activePower, activeBrush]
  );

  // Phase 5: Chronomancer toggles — they fire once and don't enter brush mode.
  const toggleFreeze = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.toggleFreezeTime();
    setTimeScaleState(eng.getTimeScale());
  }, []);
  const toggleWinter = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.toggleWinter();
    setWinterOn(eng.isWinter());
  }, []);
  const cancelPower = useCallback(() => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.clearPower();
    setActivePower("none");
    setActiveBrush("none");
    setOpenCategory(null);
  }, []);

  const closeMonologue = useCallback(() => {
    setMonologue(null);
    const eng = engineRef.current;
    if (!eng) return;
    const restore = prevScaleRef.current === 0 ? 1 : prevScaleRef.current;
    eng.setTimeScale(restore);
    setTimeScaleState(restore);
  }, []);

  const onTimeUpdate = useCallback((state: GameState) => {
    setGameMonth(state.time.gameMonth);
    setGameYear(state.time.gameYear);
    setTimeScaleState(state.time.timeScale);
    // Deep-clone civ + nested objects so any future memoized children see
    // changed references on resources/needs/etc., not just the top-level.
    const c = state.civilization;
    setCiv({
      population: c.population,
      treasury: c.treasury,
      founded: c.founded,
      resources: { ...c.resources },
      needs: {
        hunger: { ...c.needs.hunger },
        safety: { ...c.needs.safety },
        social: { ...c.needs.social },
        vanity: { ...c.needs.vanity },
        faith: { ...c.needs.faith },
        // Phase 14: leisure need (Tavern + DRINKING + per-citizen leisure pool).
        leisure: { ...c.needs.leisure },
      },
      monthlyTaxHistory: [...c.monthlyTaxHistory],
    });
    setBuildingCount(state.buildings.length);
    setCitizenCount(state.citizens.length);
    setHungryCount(state.citizens.filter((cz) => cz.state === "SEEK_FOOD").length);
    // Phase 18: cap visible chronicle entries to 5 (was 6) for a tighter
    // bottom-right footprint per spec.
    setChronicle(state.chronicle.slice(-5).reverse());
    setNobleDissent(state.nobleDissent);
    setDayNight(state.dayNight);
    setSeason(state.currentSeason);
    setWeather(state.currentWeather);
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current, { onTimeUpdate, onCitizenTap });
    engineRef.current = engine;
    const s = engine.getState();
    setGameMonth(s.time.gameMonth);
    setGameYear(s.time.gameYear);
    setTimeScaleState(s.time.timeScale);
    setCiv({ ...s.civilization });
    setBuildingCount(s.buildings.length);
    setCitizenCount(s.citizens.length);
    setHungryCount(s.citizens.filter((cz) => cz.state === "SEEK_FOOD").length);
    setChronicle(s.chronicle.slice(-5).reverse());
    setNobleDissent(s.nobleDissent);
    setDayNight(s.dayNight);
    setSeason(s.currentSeason);
    setWeather(s.currentWeather);
    setWinterOn(s.winterActive);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [onTimeUpdate, onCitizenTap]);

  // Phase 10.5: Poll engine.getFPS() at ~4Hz from a separate rAF loop. This
  // keeps the FPS pill responsive without re-rendering the rest of the HUD
  // 60 times per second.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 250) {
        const e = engineRef.current;
        if (e) setFps(e.getFPS());
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleTimeScale = (scale: 0 | 1 | 2) => {
    engineRef.current?.setTimeScale(scale);
    setTimeScaleState(scale);
  };

  const monthLabel = MONTH_NAMES[(gameMonth - 1) % 12];

  return (
    <div className="game-root" data-active-power={activePower}>
      {/* Phase 19: canvas wrapped so we can paint a tilt-shift miniature
          effect (top + bottom 15% blur bands) above it without affecting
          the rendering pipeline. The canvas itself receives the +25%
          saturation filter via .game-canvas CSS. */}
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="tilt-shift-band tilt-shift-band-top" aria-hidden="true" />
      <div className="tilt-shift-band tilt-shift-band-bottom" aria-hidden="true" />

      {/* Top: clock + resources */}
      <div className="hud-top">
        <div className="hud-time">
          <span className="hud-date">{monthLabel} Year {gameYear}</span>
          <span
            className="hud-daynight"
            title={dayNight === "night" ? "Night — citizens sleep" : "Day"}
            style={{
              marginLeft: 8,
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              background: dayNight === "night" ? "#1a1f3a" : "#fef3c7",
              color: dayNight === "night" ? "#c4d4ff" : "#92400e",
            }}
          >
            {dayNight === "night" ? "☾ NIGHT" : "☀ DAY"}
          </span>
          {/* Phase 13: Season pill — derived from gameMonth on the engine. */}
          <span
            className="hud-season"
            title={`Season: ${season.charAt(0) + season.slice(1).toLowerCase()}`}
            style={{
              marginLeft: 8,
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              background:
                season === "SPRING" ? "#dcfce7" :
                season === "SUMMER" ? "#fef9c3" :
                season === "AUTUMN" ? "#fed7aa" :
                "#e0f2fe",
              color:
                season === "SPRING" ? "#166534" :
                season === "SUMMER" ? "#854d0e" :
                season === "AUTUMN" ? "#9a3412" :
                "#075985",
            }}
          >
            {season === "SPRING" ? "🌱 SPRING" :
             season === "SUMMER" ? "☼ SUMMER" :
             season === "AUTUMN" ? "🍂 AUTUMN" :
             "❄ WINTER"}
          </span>
          {/* Phase 13: Weather pill — re-rolled at every dawn. */}
          <span
            className="hud-weather"
            title={`Weather: ${weather.charAt(0) + weather.slice(1).toLowerCase()}`}
            style={{
              marginLeft: 8,
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              background:
                weather === "CLEAR" ? "#fef3c7" :
                weather === "RAIN" ? "#bae6fd" :
                weather === "SNOW" ? "#f1f5f9" :
                "#312e81",
              color:
                weather === "CLEAR" ? "#92400e" :
                weather === "RAIN" ? "#075985" :
                weather === "SNOW" ? "#334155" :
                "#e0e7ff",
            }}
          >
            {weather === "CLEAR" ? "☀ CLEAR" :
             weather === "RAIN" ? "☂ RAIN" :
             weather === "SNOW" ? "❄ SNOW" :
             "⚡ STORM"}
          </span>
          <span
            className="hud-fps"
            title="Frames per second"
            style={{
              marginLeft: 8,
              padding: "2px 8px",
              borderRadius: 10,
              fontSize: 11,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              background: fps >= 50 ? "#064e3b" : fps >= 30 ? "#78350f" : "#7f1d1d",
              color: fps >= 50 ? "#a7f3d0" : fps >= 30 ? "#fde68a" : "#fecaca",
            }}
          >
            {fps} FPS
          </span>
          {nobleDissent !== "LOW" && (
            <span
              className="hud-dissent"
              title={`Noble dissent: ${nobleDissent}`}
              style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 10,
                fontSize: 11,
                background: nobleDissent === "HIGH" ? "#7f1d1d" : "#78350f",
                color: "#fee2e2",
              }}
            >
              ⚔ {nobleDissent} DISSENT
            </span>
          )}
        </div>

        {civ && (
          <div className="hud-resources">
            <div className="resource" title="Treasury">
              <span className="resource-icon" style={{ color: "#f4cf5b" }}>◆</span>
              <span className="resource-val">{fmt(civ.treasury)}</span>
            </div>
            <div className="resource" title="Bread">
              <span className="resource-icon" style={{ color: "#e8a23a" }}>◍</span>
              <span className="resource-val">{fmt(civ.resources.bread)}</span>
            </div>
            <div className="resource" title="Wheat">
              <span className="resource-icon" style={{ color: "#d4b86a" }}>◎</span>
              <span className="resource-val">{fmt(civ.resources.wheat)}</span>
            </div>
            <div className="resource" title="Wood">
              <span className="resource-icon" style={{ color: "#8b6f4a" }}>▲</span>
              <span className="resource-val">{fmt(civ.resources.wood)}</span>
            </div>
            <div className="resource" title="Stone">
              <span className="resource-icon" style={{ color: "#9aa0ad" }}>■</span>
              <span className="resource-val">{fmt(civ.resources.stone)}</span>
            </div>
            <div className="resource resource-pop" title="Population">
              <span className="resource-icon" style={{ color: "#7fc4ff" }}>☺</span>
              <span className="resource-val">{civ.population}</span>
            </div>
            <div className="resource" title="Buildings">
              <span className="resource-icon" style={{ color: "#a8b3c4" }}>⌂</span>
              <span className="resource-val">{buildingCount}</span>
            </div>
            <div
              className={`resource ${hungryCount > 0 ? "resource-alert" : ""}`}
              title={hungryCount > 0 ? `${hungryCount} citizen(s) seeking food` : "Citizens (NPCs)"}
            >
              <span
                className="resource-icon"
                style={{ color: hungryCount > 0 ? "#ff8c2a" : "#c4d4ff" }}
              >
                ☻
              </span>
              <span className="resource-val">
                {citizenCount}
                {hungryCount > 0 && (
                  <span className="resource-alert-suffix"> ⚠{hungryCount}</span>
                )}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Left: needs panel (utility AI brain).
          Phase 18: collapsible. By default we render ONLY the Hunger row
          (the most actionable need); the panel expands on hover OR when
          `needsExpanded` is true (click to pin open, click again to
          collapse). The CSS `:hover` rule + the `expanded` modifier
          class both reveal `.need-row.secondary`. */}
      {civ && (
        <div
          className={`hud-needs ${needsExpanded ? "expanded" : "collapsed"}`}
          onClick={() => setNeedsExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          aria-label={needsExpanded ? "Collapse Civic Needs" : "Expand Civic Needs"}
          aria-expanded={needsExpanded}
        >
          <div className="needs-title">
            CIVIC NEEDS
            <span className="needs-toggle-glyph" aria-hidden="true">
              {needsExpanded ? "▾" : "▸"}
            </span>
          </div>
          {ALL_NEEDS.map((n) => {
            const need = civ.needs[n];
            const pct = Math.max(0, Math.min(100, need.value));
            // Hunger is always visible (primary). Everything else is a
            // secondary row hidden until expand/hover.
            const isPrimary = n === "hunger";
            return (
              <div
                key={n}
                className={`need-row ${isPrimary ? "primary" : "secondary"}`}
              >
                <span className="need-label" style={{ color: NEED_COLORS[n] }}>
                  {NEED_LABELS[n]}
                </span>
                <div className="need-track">
                  <div
                    className="need-fill"
                    style={{
                      width: `${pct}%`,
                      background: NEED_COLORS[n],
                    }}
                  />
                </div>
                <span className="need-val">{Math.round(pct)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Phase 4: Inner Monologue tooltip + click-anywhere-to-close scrim */}
      {monologue && (
        <div className="monologue-scrim" onClick={closeMonologue} onTouchStart={closeMonologue}>
          <div
            className="monologue"
            style={{
              left: Math.max(12, Math.min(window.innerWidth - 260, monologue.x - 130)),
              top: Math.max(12, monologue.y - 96),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="monologue-name">
              {monologue.citizen.name}
              {monologue.citizen.lastName ? ` ${monologue.citizen.lastName}` : ""}
              <span className="monologue-role">
                {monologue.citizen.isKing ? "the King"
                  : monologue.citizen.isDowagerQueen ? "Dowager Queen"
                  : monologue.citizen.isQueen ? "the Queen"
                  : monologue.citizen.isPrince ? "Heir"
                  : monologue.citizen.faction === "rebel" ? "Rebel"
                  : monologue.citizen.faction === "royalist" ? "Royalist"
                  : monologue.citizen.profession && monologue.citizen.profession !== "None"
                    ? monologue.citizen.profession
                    : "Citizen"}
              </span>
            </div>
            {/* Phase 12: micro-state line + mood bar */}
            {(() => {
              const c = monologue.citizen;
              const microState = (() => {
                switch (c.state) {
                  case "CHATTING": return "Chatting";
                  case "MENTAL_BREAK":
                    if (c.breakKind === "DOOMSAYER") return "Mental Break: Doomsayer";
                    if (c.breakKind === "RECLUSE") return "Mental Break: Recluse";
                    if (c.breakKind === "THIEF") return "Mental Break: Thief";
                    return "Mental Break";
                  case "PRAYING": return "Praying";
                  case "SLEEPING": return "Sleeping";
                  case "COMBAT": return "In Combat";
                  case "DEAD": return "Deceased";
                  case "FLEEING": return "Fleeing";
                  case "SEEK_FOOD": return "Seeking Food";
                  case "ROGUE": return "Rogue";
                  case "REBEL": return "Rebel";
                  case "MOVING": return c.targetTile ? "Traveling" : "Walking";
                  case "WORKING": return "Working";
                  case "MINISTERING": return "Ministering";
                  // Phase 14 — Living City Expansion
                  case "STEALING": return "Stealing";
                  case "ARRESTING": return "Arresting Thief";
                  case "IMPRISONED": return "Imprisoned";
                  case "HEALING": return "Treating Patient";
                  case "DRINKING": return "At the Tavern";
                  case "IDLE":
                  default: return "Idle";
                }
              })();
              const mood = typeof c.mood === "number" ? c.mood : 100;
              // Color shifts green → yellow → red as mood drops.
              const moodColor =
                mood >= 66 ? "#4ade80" :
                mood >= 33 ? "#fde047" :
                "#ef4444";
              return (
                <div style={{ marginTop: 6 }}>
                  <div style={{
                    fontSize: 11,
                    color: "#c8b890",
                    fontStyle: "italic",
                    marginBottom: 4,
                  }}>
                    {microState}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{
                      flex: 1,
                      height: 6,
                      background: "rgba(0,0,0,0.45)",
                      borderRadius: 3,
                      overflow: "hidden",
                      border: "1px solid rgba(180, 160, 100, 0.3)",
                    }}>
                      <div style={{
                        width: `${Math.max(0, Math.min(100, mood))}%`,
                        height: "100%",
                        background: moodColor,
                        transition: "width 0.3s ease, background 0.3s ease",
                      }} />
                    </div>
                    <span style={{ fontSize: 10, color: "#e8d8a8", minWidth: 64, textAlign: "right" }}>
                      Mood {Math.round(mood)}/100
                    </span>
                  </div>
                </div>
              );
            })()}
            <div className="monologue-text">"{buildMonologue(monologue.citizen)}"</div>
            {/* Phase 9: Trait + Skill Level + grudge readout. */}
            {(() => {
              const c = monologue.citizen;
              const showSkill =
                !!c.skills &&
                c.profession &&
                c.profession !== "None" &&
                (c.profession === "Farmer" ||
                  c.profession === "Miner" ||
                  c.profession === "Guard");
              if (!c.trait && !showSkill) return null;
              return (
                <div className="monologue-meta">
                  {c.trait && <span className="monologue-trait">{c.trait}</span>}
                  {showSkill && (
                    <span className="monologue-skill">
                      {c.profession} Lv {c.skills!.level}
                      <span className="monologue-xp">
                        {" "}
                        ({c.skills!.xp}/100 XP)
                      </span>
                    </span>
                  )}
                </div>
              );
            })()}
            {(() => {
              const c = monologue.citizen;
              if (!c.memory) return null;
              const grudgeIds = Object.keys(c.memory).filter(
                (id) => (c.memory![id] ?? 0) < 0
              );
              if (grudgeIds.length === 0) return null;
              const all = engineRef.current?.getState().citizens ?? [];
              const names = grudgeIds.slice(0, 2).map((id) => {
                const other = all.find((x) => x.id === id);
                return other ? other.name : id;
              });
              const more =
                grudgeIds.length > names.length
                  ? ` +${grudgeIds.length - names.length}`
                  : "";
              return (
                <div className="monologue-grudge">
                  Despises: {names.join(", ")}
                  {more}
                </div>
              );
            })()}
            <div className="monologue-hint">tap anywhere to dismiss</div>
          </div>
        </div>
      )}

      {/* Bottom-right: Royal Chronicle (Phase 17b position, Phase 18 toggle).
          A small "gold leaf" star button on the title bar minimizes the
          panel down to just the title strip — the user can hide history
          completely while still seeing where the panel lives. */}
      {chronicle.length > 0 && (
        <div className={`royal-chronicle ${chronicleMinimized ? "minimized" : ""}`}>
          <div className="chronicle-title">
            <span className="chronicle-title-text">✦ Royal Chronicle ✦</span>
            <button
              className="chronicle-toggle"
              onClick={() => setChronicleMinimized((v) => !v)}
              aria-label={chronicleMinimized ? "Expand Royal Chronicle" : "Minimize Royal Chronicle"}
              aria-expanded={!chronicleMinimized}
              title={chronicleMinimized ? "Show history" : "Hide history"}
            >
              {chronicleMinimized ? "✦" : "❖"}
            </button>
          </div>
          {!chronicleMinimized && chronicle.map((e, i) => (
            <div
              key={`${e.year}-${e.month}-${i}`}
              className="chronicle-entry"
              style={{ opacity: 1 - i * 0.10 }}
            >
              <span className="chronicle-year">Y{e.year}</span>
              <span className="chronicle-text">{e.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Phase 5: Divine Powers toolbar (right side, glassmorphism) */}
      <div className="divine-toolbar" role="toolbar" aria-label="Divine Powers">
        {(["architect", "judge", "wrath", "chronomancer"] as ToolbarCategory[]).map((cat) => {
          const isOpen = openCategory === cat;
          const isActive =
            (cat !== "chronomancer" && CAT_TO_POWER[cat] === activePower) ||
            (cat === "chronomancer" && (winterOn || timeScale === 0));
          return (
            <div className={`tool-group ${isOpen ? "open" : ""}`} key={cat}>
              <button
                className={`tool-btn ${isActive ? "active" : ""}`}
                onClick={() => setOpenCategory(isOpen ? null : cat)}
                aria-label={CAT_LABELS[cat]}
                aria-expanded={isOpen}
                title={CAT_LABELS[cat]}
              >
                <span className="tool-glyph">{CAT_GLYPHS[cat]}</span>
                <span className="tool-label">{CAT_LABELS[cat]}</span>
              </button>
              {isOpen && (
                <div className="tool-submenu">
                  {cat === "chronomancer" ? (
                    <>
                      <button
                        className={`tool-sub-btn ${timeScale === 0 ? "active" : ""}`}
                        onClick={toggleFreeze}
                      >
                        <span className="tool-glyph">❄</span>
                        <span>{timeScale === 0 ? "Unfreeze" : "Freeze Time"}</span>
                      </button>
                      <button
                        className={`tool-sub-btn ${winterOn ? "active" : ""}`}
                        onClick={toggleWinter}
                      >
                        <span className="tool-glyph">☃</span>
                        <span>{winterOn ? "End Winter" : "Summon Winter"}</span>
                      </button>
                    </>
                  ) : (
                    BRUSH_GROUPS[cat].map((opt) => {
                      const isSel =
                        activePower === CAT_TO_POWER[cat] && activeBrush === opt.id;
                      return (
                        <button
                          key={opt.id}
                          className={`tool-sub-btn ${isSel ? "active" : ""}`}
                          onClick={() => selectBrush(cat, opt.id)}
                        >
                          <span className="tool-glyph">{opt.glyph}</span>
                          <span>{opt.label}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Phase 5: Active power banner (replaces toolbar tooltips) */}
      {activePower !== "none" && (
        <div className="power-banner">
          <span className="power-banner-label">DIVINE POWER ACTIVE</span>
          <span className="power-banner-value">
            {activePower.toUpperCase()} · {activeBrush.replace(/^paint_/, "").toUpperCase()}
          </span>
          <button className="power-banner-cancel" onClick={cancelPower}>
            Cancel
          </button>
        </div>
      )}

      {/* Bottom: time controls */}
      <div className="hud-bottom">
        <div className="time-controls">
          <button
            className={`time-btn ${timeScale === 0 ? "active" : ""}`}
            onClick={() => handleTimeScale(0)}
            aria-label="Pause"
          >
            ⏸
          </button>
          <button
            className={`time-btn ${timeScale === 1 ? "active" : ""}`}
            onClick={() => handleTimeScale(1)}
            aria-label="Normal speed"
          >
            ▶
          </button>
          <button
            className={`time-btn ${timeScale === 2 ? "active" : ""}`}
            onClick={() => handleTimeScale(2)}
            aria-label="Fast speed"
          >
            ⏩
          </button>
        </div>
      </div>
    </div>
  );
}
