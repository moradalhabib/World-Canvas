import { useEffect, useRef, useState, useCallback } from "react";
import { GameEngine } from "./game/GameEngine";
import type { CitizenTapInfo } from "./game/GameEngine";
import type { Citizen, CivilizationState, GameState } from "./game/types";
import { ALL_NEEDS, NEED_COLORS, NEED_LABELS } from "./game/types";

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
  // Phase 4: Inner Monologue overlay state.
  const [monologue, setMonologue] = useState<{
    citizen: Citizen;
    x: number;
    y: number;
  } | null>(null);
  // Remembered timeScale at the moment the monologue paused the game.
  const prevScaleRef = useRef<0 | 1 | 2>(1);

  const onCitizenTap = useCallback((info: CitizenTapInfo) => {
    const eng = engineRef.current;
    if (!eng) return;
    prevScaleRef.current = eng.getTimeScale();
    eng.setTimeScale(0);
    setTimeScaleState(0);
    setMonologue({ citizen: info.citizen, x: info.screenX, y: info.screenY });
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
      },
      monthlyTaxHistory: [...c.monthlyTaxHistory],
    });
    setBuildingCount(state.buildings.length);
    setCitizenCount(state.citizens.length);
    setHungryCount(state.citizens.filter((cz) => cz.state === "SEEK_FOOD").length);
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
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [onTimeUpdate, onCitizenTap]);

  const handleTimeScale = (scale: 0 | 1 | 2) => {
    engineRef.current?.setTimeScale(scale);
    setTimeScaleState(scale);
  };

  const monthLabel = MONTH_NAMES[(gameMonth - 1) % 12];

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* Top: clock + resources */}
      <div className="hud-top">
        <div className="hud-time">
          <span className="hud-date">{monthLabel} Year {gameYear}</span>
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

      {/* Left: needs panel (utility AI brain) */}
      {civ && (
        <div className="hud-needs">
          <div className="needs-title">CIVIC NEEDS</div>
          {ALL_NEEDS.map((n) => {
            const need = civ.needs[n];
            const pct = Math.max(0, Math.min(100, need.value));
            return (
              <div key={n} className="need-row">
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
            <div className="monologue-text">"{buildMonologue(monologue.citizen)}"</div>
            <div className="monologue-hint">tap anywhere to dismiss</div>
          </div>
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
