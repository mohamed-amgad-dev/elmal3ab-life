import type { ISoundEngine } from '../types/engine';

type AudioContextCtor = new () => AudioContext;

/**
 * 100% procedural Web Audio API sound engine for ElMal3abLife (الملعب لايف).
 * Lazily initializes AudioContext on user gesture and routes all voices through
 * a DynamicsCompressorNode + master GainNode to prevent clipping.
 */
export class SoundEngine implements ISoundEngine {
  private ctx: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private disposed = false;

  public unlock(): void {
    if (this.disposed) return;
    try {
      const ctx = this.ensureContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          // Ignore autoplay/headless resume rejections
        });
      }
    } catch {
      // Gracefully ignore environments without Web Audio support
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    try {
      if (this.masterGain && this.ctx && this.ctx.state !== 'closed') {
        this.masterGain.gain.setTargetAtTime(
          muted ? 0 : 0.85,
          this.ctx.currentTime,
          0.015
        );
      }
    } catch {
      // Ignore if context is unavailable
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public playWhistle(type: 'short' | 'long' | 'double'): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    if (type === 'short') {
      this.triggerPeaWhistleBlast(ctx, out, t, 0.24, false);
    } else if (type === 'long') {
      this.triggerPeaWhistleBlast(ctx, out, t, 0.78, true);
    } else {
      this.triggerPeaWhistleBlast(ctx, out, t, 0.16, false);
      this.triggerPeaWhistleBlast(ctx, out, t + 0.24, 0.3, false);
    }
  }

  public playKick(power: number): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;
    const p = this.clamp(Number.isFinite(power) ? power : 0.7, 0.15, 1.5);
    const vol = 0.28 + 0.42 * Math.min(p, 1.2);

    // Punchy pitch-dropped sine sub-thump (150Hz -> 45Hz)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(150 + 25 * Math.min(p, 1), t);
    subOsc.frequency.exponentialRampToValueAtTime(45, t + 0.11);

    subGain.gain.setValueAtTime(0.0001, t);
    subGain.gain.linearRampToValueAtTime(vol, t + 0.004);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);

    subOsc.connect(subGain);
    subGain.connect(out);
    subOsc.start(t);
    subOsc.stop(t + 0.18);

    // Short filtered noise pop scaled by power
    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(850 + 650 * Math.min(p, 1), t);
      filter.Q.setValueAtTime(1.4, t);

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.0001, t);
      nGain.gain.linearRampToValueAtTime(vol * 0.55, t + 0.003);
      nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);

      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(out);
      noise.start(t);
      noise.stop(t + 0.07);
    }
  }

  public playPostClang(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Two inharmonic FM metallic bell/post partials
    const partials: Array<{
      carrierFreq: number;
      modFreq: number;
      modIndex: number;
      gain: number;
      decay: number;
    }> = [
      { carrierFreq: 520, modFreq: 1410, modIndex: 420, gain: 0.36, decay: 1.05 },
      { carrierFreq: 1185, modFreq: 2730, modIndex: 340, gain: 0.24, decay: 0.85 },
      { carrierFreq: 2140, modFreq: 3590, modIndex: 180, gain: 0.12, decay: 0.5 },
    ];

    for (const part of partials) {
      const carrier = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const amp = ctx.createGain();

      carrier.type = 'sine';
      carrier.frequency.setValueAtTime(part.carrierFreq, t);

      mod.type = 'sine';
      mod.frequency.setValueAtTime(part.modFreq, t);
      modGain.gain.setValueAtTime(part.modIndex, t);
      modGain.gain.exponentialRampToValueAtTime(1, t + 0.22);

      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.linearRampToValueAtTime(part.gain, t + 0.002);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + part.decay);

      mod.connect(modGain);
      modGain.connect(carrier.frequency);
      carrier.connect(amp);
      amp.connect(out);

      mod.start(t);
      carrier.start(t);
      mod.stop(t + part.decay + 0.02);
      carrier.stop(t + part.decay + 0.02);
    }

    // Crisp metallic impact transient
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = 'triangle';
    click.frequency.setValueAtTime(1600, t);
    click.frequency.exponentialRampToValueAtTime(220, t + 0.035);
    clickGain.gain.setValueAtTime(0.28, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    click.connect(clickGain);
    clickGain.connect(out);
    click.start(t);
    click.stop(t + 0.05);
  }

  public playGoalCelebration(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // 1. Filtered stadium crowd noise swell
    if (this.noiseBuffer) {
      const crowd = ctx.createBufferSource();
      crowd.buffer = this.noiseBuffer;
      crowd.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(380, t);
      bp.frequency.exponentialRampToValueAtTime(1450, t + 0.55);
      bp.frequency.exponentialRampToValueAtTime(800, t + 2.3);
      bp.Q.setValueAtTime(0.85, t);

      const cGain = ctx.createGain();
      cGain.gain.setValueAtTime(0.0001, t);
      cGain.gain.linearRampToValueAtTime(0.45, t + 0.25);
      cGain.gain.setValueAtTime(0.4, t + 1.2);
      cGain.gain.exponentialRampToValueAtTime(0.0001, t + 2.35);

      crowd.connect(bp);
      bp.connect(cGain);
      cGain.connect(out);
      crowd.start(t);
      crowd.stop(t + 2.4);
    }

    // 2. Celebratory synth brass fanfare chord (pickup + major triad)
    const pickup = [523.25, 659.25]; // C5, E5
    pickup.forEach((freq, idx) => {
      this.triggerBrassVoice(ctx, out, t + idx * 0.13, 0.12, freq, 0.14);
    });
    const chord = [261.63, 392.0, 523.25, 659.25, 783.99]; // C4 G4 C5 E5 G5
    chord.forEach((freq) => {
      this.triggerBrassVoice(ctx, out, t + 0.28, 1.05, freq, 0.11);
    });

    // 3. Stadium airhorn double burst
    this.triggerAirhorn(ctx, out, t + 0.05, 0.16);
    this.triggerAirhorn(ctx, out, t + 0.27, 0.65);
  }

  public playCrowdReaction(type: 'cheer' | 'ooh' | 'boo'): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      noise.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';

      const murmur = ctx.createBufferSource();
      murmur.buffer = this.noiseBuffer;
      murmur.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(280, t);

      const gain = ctx.createGain();
      const mGain = ctx.createGain();
      let duration = 1.1;

      if (type === 'cheer') {
        duration = 1.25;
        bp.frequency.setValueAtTime(450, t);
        bp.frequency.exponentialRampToValueAtTime(1750, t + 0.45);
        bp.frequency.exponentialRampToValueAtTime(950, t + duration);
        bp.Q.setValueAtTime(1.1, t);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.36, t + 0.18);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        mGain.gain.setValueAtTime(0.0001, t);
        mGain.gain.linearRampToValueAtTime(0.22, t + 0.15);
        mGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      } else if (type === 'ooh') {
        duration = 0.95;
        bp.frequency.setValueAtTime(700, t);
        bp.frequency.exponentialRampToValueAtTime(1180, t + 0.22);
        bp.frequency.exponentialRampToValueAtTime(380, t + duration);
        bp.Q.setValueAtTime(2.6, t);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.34, t + 0.14);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        mGain.gain.setValueAtTime(0.0001, t);
        mGain.gain.linearRampToValueAtTime(0.18, t + 0.12);
        mGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      } else {
        duration = 1.3;
        bp.frequency.setValueAtTime(310, t);
        bp.frequency.exponentialRampToValueAtTime(185, t + duration);
        bp.Q.setValueAtTime(2.2, t);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.35, t + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        mGain.gain.setValueAtTime(0.0001, t);
        mGain.gain.linearRampToValueAtTime(0.26, t + 0.18);
        mGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        // Low disapproving crowd drone for boo
        const drone1 = ctx.createOscillator();
        const drone2 = ctx.createOscillator();
        const dFilter = ctx.createBiquadFilter();
        const dGain = ctx.createGain();
        drone1.type = 'sawtooth';
        drone2.type = 'sawtooth';
        drone1.frequency.setValueAtTime(112, t);
        drone1.frequency.linearRampToValueAtTime(92, t + duration);
        drone2.frequency.setValueAtTime(117, t);
        drone2.frequency.linearRampToValueAtTime(96, t + duration);

        dFilter.type = 'lowpass';
        dFilter.frequency.setValueAtTime(320, t);
        dGain.gain.setValueAtTime(0.0001, t);
        dGain.gain.linearRampToValueAtTime(0.1, t + 0.22);
        dGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

        drone1.connect(dFilter);
        drone2.connect(dFilter);
        dFilter.connect(dGain);
        dGain.connect(out);
        drone1.start(t);
        drone2.start(t);
        drone1.stop(t + duration + 0.02);
        drone2.stop(t + duration + 0.02);
      }

      noise.connect(bp);
      bp.connect(gain);
      gain.connect(out);
      noise.start(t);
      noise.stop(t + duration + 0.03);

      murmur.connect(lp);
      lp.connect(mGain);
      mGain.connect(out);
      murmur.start(t);
      murmur.stop(t + duration + 0.03);
    }
  }

  public playCard(color: 'yellow' | 'red'): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    if (color === 'yellow') {
      // Sharp warning synth stinger
      const notes = [587.33, 880.0]; // D5 -> A5
      notes.forEach((freq, i) => {
        const start = t + i * 0.09;
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, start);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(3200, start);
        filter.frequency.exponentialRampToValueAtTime(1100, start + 0.18);

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.24, start + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);
        osc.start(start);
        osc.stop(start + 0.24);
      });
    } else {
      // Dramatic low-brass power sting (tritone + octave punch)
      const freqs = [65.41, 130.81, 185.0, 261.63]; // C2, C3, F#3, C4
      freqs.forEach((freq) => {
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.96, t + 0.72);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(2200, t);
        filter.frequency.exponentialRampToValueAtTime(260, t + 0.7);
        filter.Q.setValueAtTime(2.5, t);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.015);
        gain.gain.setValueAtTime(0.15, t + 0.28);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.78);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(out);
        osc.start(t);
        osc.stop(t + 0.8);
      });
    }
  }

  public playVARChime(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Futuristic broadcast VAR synth triad sweep: D5 -> F#5 -> A5 -> D6
    const arp = [587.33, 739.99, 880.0, 1174.66];
    arp.forEach((freq, idx) => {
      const start = t + idx * 0.085;
      const dur = idx === arp.length - 1 ? 0.65 : 0.26;

      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      oscA.type = 'triangle';
      oscB.type = 'sine';
      oscA.frequency.setValueAtTime(freq, start);
      oscB.frequency.setValueAtTime(freq * 1.004, start);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, start);
      filter.frequency.exponentialRampToValueAtTime(4200, start + 0.06);
      filter.frequency.exponentialRampToValueAtTime(1600, start + dur);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(idx === arp.length - 1 ? 0.24 : 0.18, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      oscA.connect(filter);
      oscB.connect(filter);
      filter.connect(gain);
      gain.connect(out);

      oscA.start(start);
      oscB.start(start);
      oscA.stop(start + dur + 0.02);
      oscB.stop(start + dur + 0.02);
    });
  }

  public playBenchBuzzer(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // 1. Electronic substitution buzzer
    const buz1 = ctx.createOscillator();
    const buz2 = ctx.createOscillator();
    const bFilter = ctx.createBiquadFilter();
    const bGain = ctx.createGain();

    buz1.type = 'square';
    buz2.type = 'sawtooth';
    buz1.frequency.setValueAtTime(150, t);
    buz2.frequency.setValueAtTime(225, t);

    bFilter.type = 'lowpass';
    bFilter.frequency.setValueAtTime(1250, t);

    bGain.gain.setValueAtTime(0.0001, t);
    bGain.gain.linearRampToValueAtTime(0.2, t + 0.01);
    bGain.gain.setValueAtTime(0.19, t + 0.18);
    bGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.23);

    buz1.connect(bFilter);
    buz2.connect(bFilter);
    bFilter.connect(bGain);
    bGain.connect(out);
    buz1.start(t);
    buz2.start(t);
    buz1.stop(t + 0.25);
    buz2.stop(t + 0.25);

    // 2. Comedic descending "wah-wah-wah-waaaah" notes
    const wahNotes = [
      { freq: 311.13, offset: 0.26, dur: 0.18, droop: 0.97 }, // Eb4
      { freq: 293.66, offset: 0.46, dur: 0.18, droop: 0.97 }, // D4
      { freq: 277.18, offset: 0.66, dur: 0.18, droop: 0.96 }, // C#4
      { freq: 261.63, offset: 0.86, dur: 0.48, droop: 0.88 }, // C4 comedic droop
    ];

    for (const n of wahNotes) {
      const start = t + n.offset;
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(n.freq, start);
      osc.frequency.exponentialRampToValueAtTime(n.freq * n.droop, start + n.dur);

      filter.type = 'lowpass';
      filter.Q.setValueAtTime(4.2, start);
      filter.frequency.setValueAtTime(420, start);
      filter.frequency.exponentialRampToValueAtTime(1200, start + n.dur * 0.3);
      filter.frequency.exponentialRampToValueAtTime(340, start + n.dur);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      osc.start(start);
      osc.stop(start + n.dur + 0.02);
    }
  }

  public playDiveWhoosh(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Cartoonish pitch-swoop slide
    const swoop = ctx.createOscillator();
    const sGain = ctx.createGain();
    swoop.type = 'sine';
    swoop.frequency.setValueAtTime(860, t);
    swoop.frequency.exponentialRampToValueAtTime(210, t + 0.25);

    sGain.gain.setValueAtTime(0.0001, t);
    sGain.gain.linearRampToValueAtTime(0.22, t + 0.02);
    sGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

    swoop.connect(sGain);
    sGain.connect(out);
    swoop.start(t);
    swoop.stop(t + 0.27);

    // Air whoosh
    if (this.noiseBuffer) {
      const whoosh = ctx.createBufferSource();
      whoosh.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1400, t);
      bp.frequency.exponentialRampToValueAtTime(320, t + 0.24);
      bp.Q.setValueAtTime(1.8, t);

      const wGain = ctx.createGain();
      wGain.gain.setValueAtTime(0.0001, t);
      wGain.gain.linearRampToValueAtTime(0.24, t + 0.04);
      wGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);

      whoosh.connect(bp);
      bp.connect(wGain);
      wGain.connect(out);
      whoosh.start(t);
      whoosh.stop(t + 0.27);
    }

    // Grass flop thud at the end
    const thudTime = t + 0.23;
    const thud = ctx.createOscillator();
    const tGain = ctx.createGain();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(125, thudTime);
    thud.frequency.exponentialRampToValueAtTime(42, thudTime + 0.1);

    tGain.gain.setValueAtTime(0.0001, thudTime);
    tGain.gain.linearRampToValueAtTime(0.32, thudTime + 0.008);
    tGain.gain.exponentialRampToValueAtTime(0.0001, thudTime + 0.14);

    thud.connect(tGain);
    tGain.connect(out);
    thud.start(thudTime);
    thud.stop(thudTime + 0.16);
  }

  public playFireworks(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // 1. Rising whistle swoosh
    const rocket = ctx.createOscillator();
    const rGain = ctx.createGain();
    rocket.type = 'sine';
    rocket.frequency.setValueAtTime(460, t);
    rocket.frequency.exponentialRampToValueAtTime(2350, t + 0.36);

    rGain.gain.setValueAtTime(0.0001, t);
    rGain.gain.linearRampToValueAtTime(0.14, t + 0.05);
    rGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.37);

    rocket.connect(rGain);
    rGain.connect(out);
    rocket.start(t);
    rocket.stop(t + 0.38);

    // 2. Deep explosion boom at apex
    const boomTime = t + 0.38;
    const boom = ctx.createOscillator();
    const bGain = ctx.createGain();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(125, boomTime);
    boom.frequency.exponentialRampToValueAtTime(34, boomTime + 0.38);

    bGain.gain.setValueAtTime(0.0001, boomTime);
    bGain.gain.linearRampToValueAtTime(0.45, boomTime + 0.01);
    bGain.gain.exponentialRampToValueAtTime(0.0001, boomTime + 0.45);

    boom.connect(bGain);
    bGain.connect(out);
    boom.start(boomTime);
    boom.stop(boomTime + 0.48);

    // 3. Burst + crackling sparkle noise bursts
    if (this.noiseBuffer) {
      const burst = ctx.createBufferSource();
      burst.buffer = this.noiseBuffer;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3600, boomTime);
      lp.frequency.exponentialRampToValueAtTime(420, boomTime + 0.4);

      const burstGain = ctx.createGain();
      burstGain.gain.setValueAtTime(0.0001, boomTime);
      burstGain.gain.linearRampToValueAtTime(0.35, boomTime + 0.008);
      burstGain.gain.exponentialRampToValueAtTime(0.0001, boomTime + 0.42);

      burst.connect(lp);
      lp.connect(burstGain);
      burstGain.connect(out);
      burst.start(boomTime);
      burst.stop(boomTime + 0.45);

      // Crackles
      const crackleOffsets = [0.43, 0.49, 0.54, 0.61, 0.68, 0.76, 0.85, 0.94];
      crackleOffsets.forEach((off, idx) => {
        if (!this.noiseBuffer) return;
        const cTime = t + off;
        const crack = ctx.createBufferSource();
        crack.buffer = this.noiseBuffer;
        const hp = ctx.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.setValueAtTime(2800 + (idx % 3) * 900, cTime);
        hp.Q.setValueAtTime(3.0, cTime);

        const cGain = ctx.createGain();
        cGain.gain.setValueAtTime(0.0001, cTime);
        cGain.gain.linearRampToValueAtTime(0.18 - idx * 0.012, cTime + 0.003);
        cGain.gain.exponentialRampToValueAtTime(0.0001, cTime + 0.032);

        crack.connect(hp);
        hp.connect(cGain);
        cGain.connect(out);
        crack.start(cTime);
        crack.stop(cTime + 0.04);
      });
    }
  }

  public playPassCall(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Two-syllable energetic teammate pass call ("باصيلي!")
    const syllables = [
      { offset: 0, dur: 0.11, fStart: 510, fEnd: 665, formant: 1280, gain: 0.22 },
      { offset: 0.13, dur: 0.16, fStart: 575, fEnd: 790, formant: 1560, gain: 0.25 },
    ];

    for (const s of syllables) {
      const start = t + s.offset;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();

      osc1.type = 'sawtooth';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(s.fStart, start);
      osc1.frequency.exponentialRampToValueAtTime(s.fEnd, start + s.dur);
      osc2.frequency.setValueAtTime(s.fStart * 2, start);
      osc2.frequency.exponentialRampToValueAtTime(s.fEnd * 2, start + s.dur);

      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(s.formant, start);
      filter.Q.setValueAtTime(2.4, start);

      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.linearRampToValueAtTime(s.gain, start + 0.014);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + s.dur);

      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(amp);
      amp.connect(out);

      osc1.start(start);
      osc2.start(start);
      osc1.stop(start + s.dur + 0.02);
      osc2.stop(start + s.dur + 0.02);
    }
  }

  public playWallSpray(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Crisp nozzle click transient
    const click = ctx.createOscillator();
    const clickGain = ctx.createGain();
    click.type = 'triangle';
    click.frequency.setValueAtTime(1850, t);
    click.frequency.exponentialRampToValueAtTime(540, t + 0.022);
    clickGain.gain.setValueAtTime(0.14, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.026);
    click.connect(clickGain);
    clickGain.connect(out);
    click.start(t);
    click.stop(t + 0.03);

    // Vanishing-foam aerosol hiss
    if (this.noiseBuffer) {
      const dur = 0.42;
      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(2100, t);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(4300, t);
      bp.frequency.exponentialRampToValueAtTime(2850, t + dur);
      bp.Q.setValueAtTime(1.5, t);

      const hGain = ctx.createGain();
      hGain.gain.setValueAtTime(0.0001, t);
      hGain.gain.linearRampToValueAtTime(0.18, t + 0.025);
      hGain.gain.setValueAtTime(0.15, t + 0.24);
      hGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      hiss.connect(hp);
      hp.connect(bp);
      bp.connect(hGain);
      hGain.connect(out);

      hiss.start(t);
      hiss.stop(t + dur + 0.02);
    }
  }

  public playShootoutTension(): void {
    const audio = this.ready();
    if (!audio) return;
    const { ctx, out } = audio;
    const t = ctx.currentTime;

    // Stadium "lub-dub" low heartbeat pulse
    const beats = [
      { offset: 0, dur: 0.19, f0: 74, f1: 34, vol: 0.34 },
      { offset: 0.23, dur: 0.24, f0: 82, f1: 36, vol: 0.28 },
    ];
    for (const b of beats) {
      const start = t + b.offset;
      const sub = ctx.createOscillator();
      const sGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(b.f0, start);
      sub.frequency.exponentialRampToValueAtTime(b.f1, start + b.dur);

      sGain.gain.setValueAtTime(0.0001, start);
      sGain.gain.linearRampToValueAtTime(b.vol, start + 0.008);
      sGain.gain.exponentialRampToValueAtTime(0.0001, start + b.dur);

      sub.connect(sGain);
      sGain.connect(out);
      sub.start(start);
      sub.stop(start + b.dur + 0.02);
    }

    // Dark suspenseful fifth swell (A2 + E3)
    const padFreqs = [110.0, 164.81];
    const padDur = 1.1;
    for (const freq of padFreqs) {
      const osc = ctx.createOscillator();
      const lp = ctx.createBiquadFilter();
      const pGain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);

      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(260, t);
      lp.frequency.exponentialRampToValueAtTime(520, t + 0.45);
      lp.frequency.exponentialRampToValueAtTime(220, t + padDur);

      pGain.gain.setValueAtTime(0.0001, t);
      pGain.gain.linearRampToValueAtTime(0.11, t + 0.25);
      pGain.gain.exponentialRampToValueAtTime(0.0001, t + padDur);

      osc.connect(lp);
      lp.connect(pGain);
      pGain.connect(out);
      osc.start(t);
      osc.stop(t + padDur + 0.02);
    }
  }

  public dispose(): void {
    this.disposed = true;
    try {
      if (this.ctx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(() => {
          // Ignore close errors
        });
      }
    } catch {
      // Ignore dispose errors
    }
    this.ctx = null;
    this.compressor = null;
    this.masterGain = null;
    this.noiseBuffer = null;
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed) return null;
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    if (typeof window === 'undefined') return null;

    const w = window as unknown as {
      AudioContext?: AudioContextCtor;
      webkitAudioContext?: AudioContextCtor;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;

    const ctx = new Ctor();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-14, ctx.currentTime);
    compressor.knee.setValueAtTime(12, ctx.currentTime);
    compressor.ratio.setValueAtTime(6, ctx.currentTime);
    compressor.attack.setValueAtTime(0.003, ctx.currentTime);
    compressor.release.setValueAtTime(0.2, ctx.currentTime);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(this.muted ? 0 : 0.85, ctx.currentTime);

    compressor.connect(masterGain);
    masterGain.connect(ctx.destination);

    this.ctx = ctx;
    this.compressor = compressor;
    this.masterGain = masterGain;
    this.noiseBuffer = this.createNoiseBuffer(ctx, 2.5);
    return ctx;
  }

  private ready(): { ctx: AudioContext; out: AudioNode } | null {
    if (this.muted || this.disposed) return null;
    try {
      const ctx = this.ensureContext();
      if (!ctx || !this.compressor) return null;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          // Ignore if not yet inside a user gesture
        });
      }
      return { ctx, out: this.compressor };
    } catch {
      return null;
    }
  }

  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private triggerPeaWhistleBlast(
    ctx: AudioContext,
    out: AudioNode,
    start: number,
    duration: number,
    endDrop: boolean
  ): void {
    const c1 = ctx.createOscillator();
    const c2 = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoDepth1 = ctx.createGain();
    const lfoDepth2 = ctx.createGain();
    const amp = ctx.createGain();

    c1.type = 'sine';
    c2.type = 'sine';
    c1.frequency.setValueAtTime(2800, start);
    c2.frequency.setValueAtTime(3100, start);

    if (endDrop) {
      c1.frequency.setValueAtTime(2800, start + duration * 0.72);
      c1.frequency.exponentialRampToValueAtTime(2480, start + duration);
      c2.frequency.setValueAtTime(3100, start + duration * 0.72);
      c2.frequency.exponentialRampToValueAtTime(2740, start + duration);
    }

    // 38Hz pea-whistle FM trill
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(38, start);
    lfoDepth1.gain.setValueAtTime(115, start);
    lfoDepth2.gain.setValueAtTime(130, start);

    lfo.connect(lfoDepth1);
    lfo.connect(lfoDepth2);
    lfoDepth1.connect(c1.frequency);
    lfoDepth2.connect(c2.frequency);

    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.linearRampToValueAtTime(0.2, start + 0.014);
    amp.gain.setValueAtTime(0.18, start + Math.max(0.02, duration - 0.04));
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    c1.connect(amp);
    c2.connect(amp);
    amp.connect(out);

    lfo.start(start);
    c1.start(start);
    c2.start(start);
    lfo.stop(start + duration + 0.02);
    c1.stop(start + duration + 0.02);
    c2.stop(start + duration + 0.02);

    // Subtle airy whistle breath
    if (this.noiseBuffer) {
      const air = ctx.createBufferSource();
      air.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2950, start);
      bp.Q.setValueAtTime(4.5, start);

      const aGain = ctx.createGain();
      aGain.gain.setValueAtTime(0.0001, start);
      aGain.gain.linearRampToValueAtTime(0.06, start + 0.015);
      aGain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      air.connect(bp);
      bp.connect(aGain);
      aGain.connect(out);
      air.start(start);
      air.stop(start + duration + 0.02);
    }
  }

  private triggerBrassVoice(
    ctx: AudioContext,
    out: AudioNode,
    start: number,
    duration: number,
    freq: number,
    level: number
  ): void {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, start);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(450, start);
    filter.frequency.exponentialRampToValueAtTime(2600, start + 0.05);
    filter.frequency.exponentialRampToValueAtTime(1100, start + duration);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(level, start + 0.025);
    gain.gain.setValueAtTime(level * 0.85, start + Math.max(0.03, duration * 0.65));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private triggerAirhorn(
    ctx: AudioContext,
    out: AudioNode,
    start: number,
    duration: number
  ): void {
    const f1 = ctx.createOscillator();
    const f2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();

    f1.type = 'sawtooth';
    f2.type = 'sawtooth';
    f1.frequency.setValueAtTime(370, start);
    f2.frequency.setValueAtTime(466.16, start);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1150, start);
    filter.Q.setValueAtTime(1.2, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.22, start + 0.015);
    gain.gain.setValueAtTime(0.2, start + Math.max(0.02, duration - 0.04));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    f1.connect(filter);
    f2.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    f1.start(start);
    f2.start(start);
    f1.stop(start + duration + 0.02);
    f2.stop(start + duration + 0.02);
  }

  private clamp(val: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, val));
  }
}
