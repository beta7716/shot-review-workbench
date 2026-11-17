// Silent visual segments share the unchanged full-film soundtrack.
// The video remains the clock: audio follows global video time and never
// continues through a paused, loading or scrubbing picture.
export class SegmentAudioSync {
  constructor(video, audio, getContext, onError = () => {}) {
    this.video = video; this.audio = audio; this.getContext = getContext; this.onError = onError;
    this.pendingPlay = null; this.blocked = false; this.waiting = false; this.destroyed = false; this.listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); this.listeners.push([target, type, fn]); };
    listen(video, 'playing', () => { this.waiting = false; this.sync({ force: true }); });
    listen(video, 'pause', () => this.stop());
    listen(video, 'ended', () => this.stop());
    listen(video, 'waiting', () => { this.waiting = true; this.stop(); });
    listen(video, 'seeking', () => { this.stop(); this.sync({ force: true }); });
    listen(video, 'seeked', () => this.sync({ force: true }));
    listen(video, 'ratechange', () => this.sync());
    listen(video, 'volumechange', () => this.sync());
    listen(video, 'timeupdate', () => this.sync());
    listen(audio, 'loadedmetadata', () => this.sync({ force: true }));
    listen(audio, 'canplay', () => this.sync());
    listen(audio, 'error', () => {
      this.stop();
      if (!this.getContext()?.usingClip || this.destroyed) return;
      if (!this.blocked) this.onError('配音载入失败，可切换“整片”继续有声审片。');
      this.blocked = true;
    });
  }

  sync({ force = false, fromGesture = false } = {}) {
    if (this.destroyed) return;
    const context = this.getContext();
    if (!context?.usingClip || !context.url) { this.stop(); return; }
    const { video, audio } = this;
    const absolute = new URL(context.url, context.baseUrl || 'http://localhost/').href;
    if (audio.src !== absolute) { this.stop(); this.blocked = false; audio.src = absolute; audio.load(); }
    if (fromGesture) { this.blocked = false; this.waiting = false; }
    audio.playbackRate = video.playbackRate || 1;
    audio.volume = video.volume ?? 1;
    // The segment has no audio track; mute it explicitly as protection if a
    // future cache is prepared with sound. Full-film mode uses video's track.
    if (!video.muted) video.muted = true;
    const desired = Math.max(0, Math.min(Number(context.duration) || Infinity, (Number(video.currentTime) || 0) + (Number(context.offset) || 0)));
    if (audio.readyState >= 1) {
      const max = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - .001) : desired;
      const position = Math.min(desired, max);
      const drift = Math.abs((Number(audio.currentTime) || 0) - position);
      if ((force && drift > .01) || drift > .16) {
        try { audio.currentTime = position; } catch { /* loadedmetadata will retry */ }
      }
    }
    const shouldPlay = this.shouldPlay(context);
    if (!shouldPlay) { this.stop(); return; }
    if (this.blocked || this.pendingPlay || !audio.paused) return;
    // Catch autoplay restrictions without an unhandled rejection. The next
    // explicit play click retries audio in the same user gesture.
    // Call play synchronously so a click's user activation also reaches audio.
    let request;
    try { request = audio.play(); } catch (error) { this.playFailed(error); return; }
    this.pendingPlay = Promise.resolve(request).then(() => {
      if (!this.shouldPlay()) audio.pause();
    }).catch(error => this.playFailed(error)).finally(() => { this.pendingPlay = null; });
  }

  shouldPlay(context = this.getContext()) {
    return !this.destroyed && Boolean(context?.usingClip && context.url) && !this.video.paused && !this.video.ended && !this.video.seeking && !this.waiting && !context.loading;
  }

  playFailed(error) {
    // pause(), a source switch and seeking can abort a pending play normally.
    // They must not turn a later segment into an autoplay-blocked state.
    if (error?.name === 'AbortError' || !this.shouldPlay()) return;
    if (!this.blocked) this.onError(error?.name === 'NotAllowedError' ? '浏览器未允许配音播放，请再次点击播放，或切换“整片”。' : '配音播放失败，请重试播放，或切换“整片”。');
    this.blocked = true;
  }

  stop() { this.audio.pause(); }

  destroy() {
    this.destroyed = true;
    this.stop();
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners = [];
  }
}
