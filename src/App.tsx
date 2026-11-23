import { useEffect, useRef } from 'react';
import { createGameBootstrap } from './engine/GameBootstrap';
import GameUI from './ui/GameUI';

export default function App() {
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const runtime = createGameBootstrap(container);
    return () => {
      runtime.dispose();
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#050918]">
      <div
        ref={canvasContainerRef}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed inset-0 z-0 h-full w-full overflow-hidden"
        aria-label="ملعب لايف ثلاثي الأبعاد"
      />
      <GameUI />
    </div>
  );
}
