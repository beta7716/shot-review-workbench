/**
 * Wait for one drawable video frame without starting playback.
 * Callers serialize seeks on a video element. Metadata and frame readiness share
 * the same timeout; every exit removes listeners and clears that timeout.
 */
export async function seekVideoFrame(video, target, { timeoutMs = 2000, tolerance = 0.001 } = {}) {
  if (!video || typeof video.addEventListener !== 'function' || typeof video.removeEventListener !== 'function') {
    throw new TypeError('seekVideoFrame requires a video element');
  }
  const requested = Number(target);
  if (!Number.isFinite(requested)) throw new TypeError('Video seek target must be finite');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Video seek timeout must be finite and non-negative');
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new TypeError('Video seek tolerance must be finite and non-negative');

  return new Promise((resolve, reject) => {
    let settled = false;
    let phase = 'metadata';
    let seekCompleted = false;
    let timer;
    const listeners = [];
    const listen = (type, listener) => {
      video.addEventListener(type, listener);
      listeners.push([type, listener]);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [type, listener] of listeners) video.removeEventListener(type, listener);
      if (error) reject(error);
      else resolve(Number(video.currentTime));
    };
    const failMedia = () => {
      const detail = video.error?.message || (video.error?.code ? `media error ${video.error.code}` : 'media error');
      finish(new Error(`Video seek failed: ${detail}`));
    };
    const progress = () => {
      if (settled) return;
      if (video.error) return failMedia();
      if (phase === 'metadata') {
        const duration = Number(video.duration);
        if (video.readyState < 1 || !Number.isFinite(duration) || duration < 0) return;
        // Seeking to exactly duration can land on EOF instead of a video frame.
        const safeEnd = duration > 0 ? duration - Math.min(0.001, duration / 2) : 0;
        const position = Math.max(0, Math.min(requested, safeEnd));
        const current = Number(video.currentTime);
        const samePosition = Number.isFinite(current) && Math.abs(current - position) <= tolerance
          && current >= 0 && (duration === 0 || current < duration);
        if (samePosition && !video.seeking) {
          phase = 'data';
          seekCompleted = true;
        } else {
          phase = 'seeking';
          // Listeners are already attached, including for synchronous providers.
          // If an existing seek is already headed here, wait for it, do not restart it.
          if (!samePosition) {
            try { video.currentTime = position; }
            catch (error) { return finish(error); }
          }
        }
      }
      if (seekCompleted && !video.seeking && video.readyState >= 2) finish();
    };

    listen('loadedmetadata', progress);
    listen('durationchange', progress);
    listen('loadeddata', progress);
    listen('canplay', progress);
    listen('seeked', () => {
      if (phase === 'seeking') seekCompleted = true;
      progress();
    });
    listen('error', failMedia);
    listen('abort', () => finish(new Error('Video seek aborted')));
    timer = setTimeout(() => {
      finish(new Error(phase === 'metadata' ? 'Video metadata timed out' : 'Video seek timed out'));
    }, timeoutMs);
    progress();
  });
}
