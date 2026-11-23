import { X } from 'lucide-react';
import { useGameStore } from '../store/useGameStore';
import { ModalShell } from './uiKit';

interface Section {
  title: string;
  emoji: string;
  accent: string;
  rows: [string, string][];
}

const SECTIONS: Section[] = [
  {
    title: 'لاعب ميدان',
    emoji: '⚽',
    accent: '#10b981',
    rows: [
      ['W A S D', 'حرّك اللاعب'],
      ['Shift', 'جري سريع (بياكل النفَس)'],
      ['Space', 'باص'],
      ['E / RMB', 'شوط (اضغط واشحن وسيب)'],
      ['C', 'ترقيصة'],
      ['F', 'زحلقة'],
      ['V', 'غطس! (لو الأدمن سامح)'],
      ['R', 'شغب واحتجاج!'],
      ['Q', 'تبديل اللاعب (PES)'],
      ['T', 'تغيير الكاميرا'],
    ],
  },
  {
    title: 'حارس مرمى 🧤',
    emoji: '🧤',
    accent: '#fbbf24',
    rows: [
      ['A / D', 'اختار اتجاه الطيران'],
      ['Space', 'طيران! (مع A/D أو الماوس)'],
      ['E', 'تشتيت / رمية'],
      ['الماوس', 'بص حواليك (منظور شخصي)'],
    ],
  },
  {
    title: 'الحكم 🟨',
    emoji: '🟨',
    accent: '#fde047',
    rows: [
      ['Space', 'صافرة'],
      ['1', 'كارت أصفر لأقرب لاعب'],
      ['2', 'طرد أحمر'],
      ['3', 'بلنتي بمزاجك! 🎯'],
      ['4', 'مراجعة VAR 📺'],
    ],
  },
  {
    title: 'المدرب 🧥',
    emoji: '🧥',
    accent: '#a78bfa',
    rows: [
      ['الماوس', 'اضغط «طلّع دكة!» جنب اللاعب'],
      ['الماوس', 'اختار التكتيك: هجوم / أتوبيس / ضغط'],
    ],
  },
  {
    title: 'الدكة 🪑',
    emoji: '🪑',
    accent: '#c084fc',
    rows: [
      ['الماوس', 'تشويح، مية، زعيق للمدرب'],
      ['الماوس', 'اطلب الرجوع للملعب'],
    ],
  },
  {
    title: 'المدرجات 🏟️',
    emoji: '🏟️',
    accent: '#00c2ff',
    rows: [
      ['الماوس', 'تشجيع / استهجان / ألعاب نارية'],
      ['T', 'كاميرا المدرج ⇄ العلوي'],
    ],
  },
  {
    title: 'عام',
    emoji: '🎛️',
    accent: '#ff2e4c',
    rows: [
      ['M', 'قايمة تبديل الدور السريع'],
      ['P / Esc', 'إيقاف مؤقت'],
    ],
  },
];

export default function ControlsHelpModal() {
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const close = () => setControlsOpen(false);

  return (
    <div className="absolute inset-0 z-50">
      <ModalShell maxWidth="max-w-5xl" onBackdrop={close}>
        <div className="p-5">
          <header className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl font-black text-white text-glow-gold">دليل التحكم 🎮</h2>
              <p className="text-xs font-bold text-slate-400">كل اختصارات كل الأدوار في مكان واحد</p>
            </div>
            <button type="button" onClick={close} aria-label="إغلاق" className="btn-ghost h-10 w-10">
              <X size={20} />
            </button>
          </header>

          <div className="grid grid-cols-3 gap-3">
            {SECTIONS.map((s) => (
              <section
                key={s.title}
                className="rounded-2xl border bg-slate-900/55 p-3"
                style={{ borderColor: `${s.accent}55` }}
              >
                <h3 className="mb-2 flex items-center gap-2 text-sm font-black" style={{ color: s.accent }}>
                  <span className="text-lg">{s.emoji}</span> {s.title}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {s.rows.map(([k, d], i) => (
                    <li key={`${k}-${i}`} className="flex items-center gap-2 text-[12px] font-bold text-slate-200">
                      <span className="kbd shrink-0 whitespace-nowrap">{k}</span>
                      <span className="leading-snug">{d}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="mt-4 flex justify-center">
            <button type="button" onClick={close} className="btn-cta h-12 px-10 text-lg">
              تمام، فهمت! 👍
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}
