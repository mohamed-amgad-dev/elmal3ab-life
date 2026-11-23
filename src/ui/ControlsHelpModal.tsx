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
      ['الماوس', 'لف الكاميرا 360° وحدد اتجاه الكرة والموزة'],
      ['Shift', 'جري سريع (بياكل النفَس)'],
      ['كليك شمال / E', 'شوط (اشحن للمنطقة الخضراء وسيب!)'],
      ['كليك يمين / Space', 'باص ذكي في اتجاه السهم'],
      ['C', 'ترقيصة'],
      ['F', 'زحلقة فيزيائية'],
      ['V', 'غطس! (لو الأدمن سامح)'],
      ['R', 'شغب واحتجاج!'],
      ['Q', 'تبديل اللاعب (PES)'],
      ['T', 'تبديل منظور اللاعب الحر ⇄ العلوي'],
    ],
  },
  {
    title: 'حارس مرمى 🧤',
    emoji: '🧤',
    accent: '#fbbf24',
    rows: [
      ['A / D', 'اختار اتجاه الطيران'],
      ['كليك شمال / Space', 'طيران للتصدي!'],
      ['كليك يمين / E', 'تشتيت / رمية'],
      ['الماوس', 'بص حواليك بسرعة (منظور شخصي)'],
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
      ['Esc', 'تحرير مؤشر الماوس / إيقاف مؤقت'],
      ['P', 'إيقاف مؤقت'],
    ],
  },
];

export default function ControlsHelpModal() {
  const setControlsOpen = useGameStore((s) => s.setControlsOpen);
  const close = () => setControlsOpen(false);

  return (
    <div className="absolute inset-0 z-50">
      <ModalShell maxWidth="max-w-6xl" onBackdrop={close}>
        <div className="p-3.5">
          <header className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-black text-white text-glow-gold">دليل التحكم 🎮</h2>
            </div>
            <button type="button" onClick={close} aria-label="إغلاق" className="btn-ghost h-8 w-8">
              <X size={16} />
            </button>
          </header>

          <div className="grid grid-cols-3 gap-2">
            {SECTIONS.map((s, idx) => (
              <section
                key={s.title}
                className={`rounded-xl border bg-slate-900/55 p-2 ${idx === 0 ? 'col-span-2' : ''}`}
                style={{ borderColor: `${s.accent}55` }}
              >
                <h3 className="mb-1 flex items-center gap-1.5 text-xs font-black" style={{ color: s.accent }}>
                  <span className="text-sm">{s.emoji}</span> {s.title}
                </h3>
                <ul className={idx === 0 ? 'grid grid-cols-2 gap-x-3 gap-y-0.5' : 'flex flex-col gap-0.5'}>
                  {s.rows.map(([k, d], i) => (
                    <li key={`${k}-${i}`} className="flex items-center gap-1.5 text-[10.5px] font-bold text-slate-200">
                      <span className="kbd shrink-0 whitespace-nowrap">{k}</span>
                      <span className="leading-tight">{d}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <div className="mt-2.5 flex justify-center">
            <button type="button" onClick={close} className="btn-cta h-9 px-8 text-sm">
              تمام، فهمت! 👍
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}
