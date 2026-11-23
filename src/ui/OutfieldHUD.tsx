import { Footprints, Gamepad2, Zap } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { Bar, CAMERA_LABEL, KeyPill } from './uiKit';

export default function OutfieldHUD() {
  const stamina = useGameStore((s) => s.stamina);
  const shotCharge = useGameStore((s) => s.shotCharge);
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
  const hot = charge > 0.75;
  const canSwitch = rules.allowTeamSwitch && slot.controlMode === 'team_switch';
  const canDive = rules.enableDivingAndProtests;
  const canCamera = rules.allowedCameras === 'both';
  const lowStamina = stamina < 25;

  return (
    <div className="absolute bottom-3 left-1/2 w-[860px] max-w-[calc(100vw-24px)] -translate-x-1/2">
      <div
        className={`glass rounded-2xl px-4 py-3 transition ${charging ? (hot ? 'glow-crimson' : 'glow-gold') : ''}`}
      >
        <div className="flex items-center gap-4">
          <div className="flex shrink-0 items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-500/15 text-emerald-300">
              <Gamepad2 size={18} />
            </span>
            <div className="leading-tight">
              <div className="max-w-[120px] truncate text-sm font-black text-white">{me ? `#${me.number} ${me.name}` : 'لاعبك'}</div>
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
          <Bar
            label={hot ? 'شوطة خارقة! 🚀' : 'شحن الشوط'}
            icon={<Zap size={12} />}
            value={charge * 100}
            from={hot ? '#fb923c' : '#d97706'}
            to={hot ? '#ff2e4c' : '#fbbf24'}
            glow={charging}
          />

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

        <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5">
          <KeyPill k="Space" label="باص" />
          <KeyPill k="E" label="شوط" active={charging} hint="اضغط واستنى.. وسيب" />
          <KeyPill
            k="C"
            label={skillCooldown > 0.05 ? `ترقيصة ${skillCooldown.toFixed(1)}ث` : 'ترقيصة'}
            dim={skillCooldown > 0.05}
          />
          <KeyPill k="F" label="زحلقة" />
          <KeyPill
            k="V"
            label={canDive && diveCooldown > 0.05 ? `غطس! ${diveCooldown.toFixed(1)}ث` : 'غطس!'}
            dim={!canDive || diveCooldown > 0.05}
            hint={canDive ? undefined : 'الأدمن قفل الغطس والشغب'}
          />
          <KeyPill k="R" label="شغب!" dim={!canDive} hint={canDive ? undefined : 'الأدمن قفل الغطس والشغب'} />
          <KeyPill k="Q" label="تبديل" dim={!canSwitch} hint={canSwitch ? undefined : 'التبديل مقفول'} />
          <KeyPill k="T" label="كاميرا" dim={!canCamera} hint={canCamera ? undefined : 'الكاميرا متثبتة من الأدمن'} />
        </div>
      </div>
    </div>
  );
}
