# ElMal3abLife (`الملعب لايف`) — Project State Snapshot

Last updated: `2026-11-26`

## 1. Tech Stack & Commands
- **Stack:** React 19, TypeScript 5.7, Vite 6.2, Tailwind CSS v4, Zustand 5, Three.js 0.175, `@dimforge/rapier3d-compat` (WASM 3D physics + fallback), PeerJS (WebRTC P2P), rigged Mixamo GLB (`public/models/player_humanoid.glb`).
- **Typecheck & Production Build (Windows-safe):**
  - Typecheck: `& "d:\ElMal3abLife\node_modules\.bin\tsc.cmd" --noEmit`
  - Build: `node d:\ElMal3abLife\node_modules\vite\bin\vite.js build` (or `npm run build`)
  - Dev Server (PowerShell execution policy bypass): `node d:\ElMal3abLife\node_modules\vite\bin\vite.js --port 5175 --host 127.0.0.1`
  - *Note:* Avoid `npx` in Windows PowerShell (`npx.ps1` is blocked by execution policy).

## 2. Core Architecture & Key Files
- **Shared Contracts & Store:**
  - `src/types/game.ts` — `AIDifficulty` (`'easy' | 'medium' | 'hard'`), `AdminRules`, `CharacterAnimState` (25 states), `MatchPhase` (includes `'free_kick_setup'`, `'penalty_shootout'`, `'red_card_drama'`, `'substitution_stoppage'`), `CallForPassState`, `CoachDisciplineStats` (`MAX_SUBS_PER_TEAM=3`, `COACH_SUB_COOLDOWN_SEC=42`, `MIN_ROUTINE_SUB_ELAPSED_SEC=35`), `FreeKickState`, `PenaltyShootoutState`, `PendingSubstitution`, `MatchDramaState`, `GameCommand` (includes `callForPass`, `refFreeKick`, `startPenaltyShootout`, `shootoutKick`), P2P packets.
  - `src/types/engine.ts` — Engine interfaces (`IBallPhysics`, `ISoundEngine` with `playPassCall`/`playWallSpray`/`playShootoutTension`, `AimingGuideParams`, `ICharacterSystem`, `IStadiumScene`).
  - `src/store/useGameStore.ts` — Zustand store (`rules.aiDifficulty`, `callForPass`, `coachDiscipline`, `freeKick`, `penaltyShootout`, `dramaState`, `pendingSub`, dual-human host/guest slot resolution).
- **Simulation, AI & Set Pieces (`src/engine/`):**
  - `src/engine/MatchEngine.ts` — Main game loop & state machine (**Warning: ~6k lines** — keep extracting new subsystems into standalone modules instead of growing this monolith). Wires AI difficulty, team passing + call-for-pass, disciplined coach subs, `FreeKickDirector`, `PenaltyShootoutDirector`, swept 3D GK saves/parries, football-law queued substitution stoppages, red-card confrontation + walk-off ceremony, VAR, goal replays, and P2P sync.
  - `src/engine/ai/TeamPassingLogic.ts` — Standalone team passing & open-space scoring module (`evaluateTeamPass`, `evaluateCallForPassTarget`, `isGroundLaneBlocked`, `computePassTrajectory`, `PassHysteresisTracker`) with strong human-open & call-for-pass priority and automatic lob recommendation when ground lane is blocked.
  - `src/engine/ai/OutfieldAI.ts` — Role-based outfield AI integrating `TeamPassingLogic`, per-team single-presser with `0.9s` hysteresis, defender cover shadow, striker diagonal runs, and Easy/Medium/Hard difficulty profiles.
  - `src/engine/ai/CoachDiscipline.ts` & `src/engine/ai/CoachAI.ts` — Standalone substitution discipline tracker (`CoachDisciplineTracker`, `evaluateCoachSubstitution`) enforcing max 3 subs/team, 42s cooldown, 35s min elapsed time (except `<18` stamina emergency), zero yellow-card ping-pong, and realistic fatigue/card/tactical triggers with Egyptian-Arabic reasons.
  - `src/engine/setpieces/FreeKickDirector.ts` — Standalone foul-to-free-kick state machine (`whistle_pause` -> `positioning` with `>= 6.8m` opponent retreat & wall formation -> `ready` for human/AI pass or curved shot -> smooth resume to `'playing'`).
  - `src/engine/setpieces/PenaltyShootoutDirector.ts` — Standalone dramatic 5-round + sudden-death penalty shootout state machine with mathematical early clinch, alternating human kicker & GK turns, AI body-lean telegraph, and 3D ball flight/save resolution.
  - `src/engine/ai/RefereeAI.ts` — Foul severity detection (`>= 0.24` whistles free kick/penalty with 2.0s hysteresis; `none`/`yellow`/`red` card classification) & VAR decisions.
  - `src/engine/ai/GoalkeeperAI.ts` — True angle-bisector positioning, ballistic 3D shot prediction, per-difficulty reaction delay, and `preferParry` detection.
  - `src/engine/cameras/CameraDirector.ts` — Multi-role camera system with `free_kick_setup` behind-taker framing, `penalty_shootout` turn-aware framing (always switches out of `gk_first_person` on kicker/finished turns while preserving `gk_first_person` on GK turns), and `dramaFocusPos` framing.
  - `src/engine/controllers/InputManager.ts` & `src/audio/SoundEngine.ts` — `KeyC` (`callForPass`), off-ball `E` call-for-pass, free-kick & shootout keyboard controls, Web Audio SFX (`playPassCall`, `playWallSpray`, `playShootoutTension`).
- **Animation & Physics:**
  - `src/engine/entities/HumanoidAnimator.ts` & `src/engine/entities/CharacterRig.ts` — All 25 `CharacterAnimState`s.
  - `src/engine/physics/RapierWorld.ts` & `src/engine/physics/BallPhysics.ts` — Rapier3D CCD + Magnus curve + `hitTouchline` detection.
- **UI (`src/ui/`):**
  - `src/ui/GameUI.tsx` — Top-level phase router (`MATCH_PHASES` includes `'free_kick_setup'`, `'penalty_shootout'`, `'red_card_drama'`, `'substitution_stoppage'`).
  - `src/ui/SetPieceHUD.tsx` — Broadcast Free Kick pill (`free-kick-banner`, `fk-pass-btn`, `fk-shoot-btn`) and Penalty Shootout scoreboard & kick/dive controls (`shootout-overlay`, `shootout-kick-*`, `shootout-dive-*`, `shootout-winner-card`).
  - `src/ui/OutfieldHUD.tsx` — Includes `call-for-pass-btn` (`C`) & pulsing `call-for-pass-active` pill.
  - `src/ui/CoachBenchPanel.tsx` — Shows `coach-subs-badge` (`التبديلات: X/3`) and cooldown timer.
  - `src/ui/RefereeControlsBar.tsx` — Includes `ref-free-kick-btn` (`5`).
  - `src/ui/MainMenu.tsx` & `src/ui/FullTimeModal.tsx` — Shootout entry points (`menu-shootout-btn`, `fulltime-shootout-btn` on draw) & Difficulty Picker.
  - `src/ui/ComedyToastFeed.tsx` — Dynamic top offset during `free_kick_setup` (`top-[196px]`) and `penalty_shootout` (`top-[240px]`) to prevent banner overlap.
  - `src/ui/Scoreboard.tsx`, `src/ui/GameHUD.tsx`, `src/ui/MatchDramaOverlay.tsx`, `src/ui/GoalkeeperHUD.tsx`, `src/ui/ControlsHelpModal.tsx`.

## 3. Verified Completed Milestones
1. **Smart Bots & Difficulty Picker:** Zero clumping, realistic AI matches, clean `easy`/`medium`/`hard` scaling.
2. **Real Goalkeeper Saves & Animations:** Swept 3D segment save check before goal detection + diving & fingertip parry saves.
3. **Football-Law Stoppages & Card/Sub Drama:** Clock freeze & resume during `substitution_stoppage` and `red_card_drama`.
4. **Team Play, Coach Discipline, Free Kicks & Penalty Shootout:** Verified live in browser (`0` console errors) with extracted modules (`TeamPassingLogic`, `CoachDiscipline`, `FreeKickDirector`, `PenaltyShootoutDirector`), fixed GK-role shootout camera inversion across all roles, and fixed toast/banner overlap.

## 4. Known Guardrails & Next-Milestone Notes
- **Browser QA Constraint:** Antigravity's `webview_browser` runs in an isolated Web Worker without `page.evaluate` / `window.*` access. Test via real UI buttons/hotkeys + `data-testid`s across **multiple roles** (outfield AND goalkeeper) when testing shared phases like shootouts/set-pieces.
- **Monolith Hygiene:** Next refactor target is extracting `DramaDirector.ts` and `GoalkeeperSaveSolver.ts` out of `MatchEngine.ts`.
- **Union Checklist:** Any new `MatchPhase` must be added to `MATCH_PHASES` in `src/ui/GameUI.tsx` and `PHASE_LABEL` in `src/ui/Scoreboard.tsx`; any new `CharacterAnimState` must be added to both `HumanoidAnimator.ts` and `CharacterRig.ts`.
