// Optional ambient soundtrack (original, procedurally synthesised; see tools/make_audio.py).
export class Ambient {
  constructor(base = './assets/audio/gargantua-ambient') {
    this.base = base;
    this.on = false;
    this.el = null;
    this.ctx = null;
    this.gain = null;
  }

  _ensure() {
    if (this.el) return;
    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.src = el.canPlayType('audio/ogg; codecs="vorbis"') ? `${this.base}.ogg` : `${this.base}.mp3`;
    this.el = el;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        const src = this.ctx.createMediaElementSource(el);
        this.gain = this.ctx.createGain();
        this.gain.gain.value = 0;
        src.connect(this.gain).connect(this.ctx.destination);
      }
    } catch (e) {
      this.ctx = null; this.gain = null;
    }
  }

  async setEnabled(on) {
    this.on = on;
    if (on) {
      this._ensure();
      try {
        if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
        if (!this.gain) this.el.volume = 0.6;
        await this.el.play();
        if (this.gain) {
          const t = this.ctx.currentTime;
          this.gain.gain.cancelScheduledValues(t);
          this.gain.gain.setValueAtTime(this.gain.gain.value, t);
          this.gain.gain.linearRampToValueAtTime(0.6, t + 3);
        }
        return true;
      } catch (e) {
        this.on = false; // autoplay blocked: needs a user gesture
        return false;
      }
    } else if (this.el) {
      if (this.gain) {
        const t = this.ctx.currentTime;
        this.gain.gain.cancelScheduledValues(t);
        this.gain.gain.setValueAtTime(this.gain.gain.value, t);
        this.gain.gain.linearRampToValueAtTime(0, t + 1.2);
        clearTimeout(this._stopT);
        this._stopT = setTimeout(() => { if (!this.on) this.el.pause(); }, 1300);
      } else this.el.pause();
    }
    return true;
  }
}
