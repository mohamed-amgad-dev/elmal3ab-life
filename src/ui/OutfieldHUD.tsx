import { Crosshair, Footprints, Gamepad2, MousePointerClick, Zap } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { Bar, CAMERA_LABEL, KeyPill } from './uiKit';

export default function OutfieldHUD() {
  const stamina = useGameStore((s) => s.stamina);
  const shotCharge = useGameStore((s) => s.shotCharge);
  const precisionZone = useGameStore((s) => s.aimPrecisionZone);
  const aimCurl = useGameStore((s) => s.aimCurl);
  const pointerLocked = useGameStore((s) => s.pointerLocked);
  const physicsBackend = useGameStore((s) => s.physicsBackend);
  const phase = useGameStore((s) => s.phase);
  const skillCooldown = useGameStore((s) => s.skillCooldown);
  const diveCooldown = useGameStore((s) => s.diveCooldown);
  const rules = useGameStore((s) => s.rules);
  const slot = useGameStore((s) => s.humanSlot);
  const activeCamera = useGameStore((s) => s.activeCamera);
  const players = useGameStore((s) => s.players);
  const controlledId = useGameStore((s) => s.controlledPlayerId);

  const me = players.find((p) => p.id === controlledId);
  const charge = Math.max(0, Math.min(1, shotCharge > 1 ? shotCharge / 100 : shotCharge));
  const charging = charge > 0.02;
  const isSweetSpot = precisionZone === 'perfect' || (charging && charge >= 0.72 && charge <= 0.88);
  const isOver = precisionZone === 'overcharge' || charge > 0.88;
  const canSwitch = rules.allowTeamSwitch && slot.controlMode === 'team_switch';
  const canDive = rules.enableDivingAndProtests;
  const canCamera = rules.allowedCameras === 'both';
  const lowStamina = stamina < 25;
  const showReticle =
    activeCamera === 'player_third' &&
    (phase === 'playing' || phase === 'penalty_setup' || phase === 'kickoff');

  const shotLabel = !charging
    ? 'شحن الشوط والدقة'
    : isSweetSpot
      ? '🎯 منطقة الدقة الذهبية!'
      : isOver
        ? '⚠️ زيادة في القوة!'
        : charge > 0.4
          ? '🔥 استنى المنطقة الخضراء!'
          : 'جاري شحن التسديدة...';

  const curlBadge =
    charging && Math.abs(aimCurl) > 0.14
      ? aimCurl > 0
        ? '↪️ موزة يمين'
        : '↩️ موزة شمال'
      : null;

  return (
    <>
      {/* Center 360° Aiming Reticle in Rematch-style Player Camera */}
      {showReticle && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div
            className={`relative flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all duration-75 ${
              isSweetSpot
                ? 'scale-125 border-emerald-300 shadow-[0_0_18px_rgba(52,211,153,0.9)]'
                : isOver
                  ? 'scale-110 border-rose-400 shadow-[0_0_14px_rgba(251,113,133,0.85)]'
                  : charging
                    ? 'scale-110 border-amber-300 shadow-[0_0_14px_rgba(251,191,36,0.75)]'
                    : 'border-cyan-300/60'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isSweetSpot
                  ? 'bg-emerald-300'
                  : isOver
                    ? 'bg-rose-400'
                    : charging
                      ? 'bg-amber-300'
                      : 'bg-cyan-200/85'
              }`}
            />
            {curlBadge && (
              <span className="absolute -top-7 rounded-full bg-slate-950/85 px-2.5 py-0.5 text-[11px] font-black whitespace-nowrap text-amber-300 border border-amber-400/50">
                {curlBadge}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Non-blocking Pointer Lock hint when in free-mouse 360 camera */}
      {showReticle && !pointerLocked && (
        <div className="pointer-events-none absolute top-[94px] left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full border border-cyan-400/40 bg-slate-950/85 px-3.5 py-1 text-[11px] font-bold whitespace-nowrap text-cyan-100 backdrop-blur-md">
            <MousePointerClick size={13} className="text-cyan-300" />
            <span>اضغط على الملعب لتحريك الكاميرا بالماوس • Esc لإظهار المؤشر</span>
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-1/2 w-[960px] max-w-[calc(100vw-24px)] -translate-x-1/2">
        <div
          className={`glass rounded-2xl px-4 py-3 transition ${
            isSweetSpot ? 'glow-emerald' : charging ? (isOver ? 'glow-crimson' : 'glow-gold') : ''
          }`}
        >
          <div className="flex items-center gap-4">
            <div className="flex shrink-0 items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-500/15 text-emerald-300">
                <Gamepad2 size={18} />
              </span>
              <div className="leading-tight">
                <div className="flex items-center gap-1.5">
                  <span className="max-w-[120px] truncate text-sm font-black text-white">
                    {me ? `#${me.number} ${me.name}` : 'لاعبك'}
                  </span>
                  {physicsBackend === 'rapier3d' && (
                    <span
                      title="محرك فيزياء ثلاثي الأبعاد Rapier3D"
                      className="rounded-md border border-cyan-400/45 bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-black text-cyan-200"
                    >
                      ⚡ Rapier3D
                    </span>
                  )}
                </div>
                <div className="text-[11px] font-bold text-slate-400">
                  {slot.positionRole === 'striker' ? 'مهاجم' : 'مدافع'} • {CAMERA_LABEL[activeCamera]}
                </div>
              </div>
            </div>

            <Bar
              label={lowStamina ? 'النفَس خلص! 😮‍💨' : 'النفَس'}
              icon={<Footprints size={12} />}
              value={stamina}
              from={lowStamina ? '#fb7185' : '#059669'}
              to={lowStamina ? '#ff2e4c' : '#34d399'}
              glow={lowStamina}
            />

            {/* Precision Timed-Finishing Sweet-Spot Bar */}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] font-bold">
                <span className="flex items-center gap-1 text-slate-200">
                  {isSweetSpot ? <Crosshair size={12} className="text-emerald-300" /> : <Zap size={12} />}
                  {shotLabel}
                </span>
                <span className="tabular-nums text-slate-300">{Math.round(charge * 100)}%</span>
              </div>
              <div
                dir="ltr"
                className="relative h-3 w-full overflow-hidden rounded-full border border-white/15 bg-slate-900/90"
              >
                {/* Sweet Spot Target Zone (72% - 88%) */}
                <div
                  className="absolute inset-y-0 z-10 border-x border-emerald-200/80 bg-emerald-400/35"
                  style={{ left: '72%', width: '16%' }}
                />
                {/* Overcharge Zone (88% - 100%) */}
                <div
                  className="absolute inset-y-0 right-0 z-10 bg-rose-500/25"
                  style={{ width: '12%' }}
                />
                {/* Charge Fill */}
                <div
                  className="h-full rounded-full transition-[width] duration-75"
                  style={{
                    width: `${Math.round(charge * 100)}%`,
                    background: isSweetSpot
                      ? 'linear-gradient(90deg, #10b981, #fbbf24)'
                      : isOver
                        ? 'linear-gradient(90deg, #fb923c, #ff2e4c)'
                        : 'linear-gradient(90deg, #d97706, #fbbf24)',
                  }}
                />
                {/* Live Precision Needle */}
                {charging && (
                  <div
                    className="absolute inset-y-0 z-20 w-1 -translate-x-1/2 rounded-full bg-white shadow-[0_0_8px_#fff]"
                    style={{ left: `${Math.round(charge * 100)}%` }}
                  />
                )}
              </div>
            </div>

            <span
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-black whitespace-nowrap ${
                canSwitch
                  ? 'border-cyan-300/60 bg-cyan-400/15 text-cyan-200'
                  : 'border-amber-300/60 bg-amber-400/15 text-amber-200'
              }`}
            >
              {canSwitch ? 'تبديل اللعيبة 🔄' : 'لاعب واحد 🔒'}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-center gap-1">
            <KeyPill k="LMB / E" label="شوط" active={charging} hint="كليك شمال أو E — اشحن للمنطقة الذهبية" />
            <KeyPill k="RMB / Space" label="باص" hint="كليك يمين أو Space" />
            <KeyPill
              k="C"
              label={skillCooldown > 0.05 ? `ترقيصة ${skillCooldown.toFixed(1)}` : 'ترقيصة'}
              dim={skillCooldown > 0.05}
            />
            <KeyPill k="F" label="زحلقة" />
            <KeyPill
              k="V"
              label={canDive && diveCooldown > 0.05 ? `غطس ${diveCooldown.toFixed(1)}` : 'غطس!'}
              dim={!canDive || diveCooldown > 0.05}
              hint={canDive ? undefined : 'الأدمن قفل الغطس والشغب'}
            />
            <KeyPill k="R" label="شغب!" dim={!canDive} hint={canDive ? undefined : 'الأدمن قفل الغطس والشغب'} />
            <KeyPill k="Q" label="تبديل" dim={!canSwitch} hint={canSwitch ? undefined : 'التبديل مقفول'} />
            <KeyPill k="T" label="كاميرا" dim={!canCamera} hint={canCamera ? undefined : 'الكاميرا متثبتة من الأدمن'} />
          </div>
        </div>
      </div>
    </>
  );
}
