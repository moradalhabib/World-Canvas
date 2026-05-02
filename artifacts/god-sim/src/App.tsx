import { useEffect, useRef, useState, useCallback } from "react";
import { GameEngine } from "./game/GameEngine";
import type { CivilizationState, GameState } from "./game/types";
import { ALL_NEEDS, NEED_COLORS, NEED_LABELS } from "./game/types";

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
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const engine = new GameEngine(canvasRef.current, { onTimeUpdate });
    engineRef.current = engine;
    const s = engine.getState();
    setGameMonth(s.time.gameMonth);
    setGameYear(s.time.gameYear);
    setTimeScaleState(s.time.timeScale);
    setCiv({ ...s.civilization });
    setBuildingCount(s.buildings.length);
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, [onTimeUpdate]);

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
