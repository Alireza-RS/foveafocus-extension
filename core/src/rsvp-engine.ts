import { FoveaFocusSettings, WordChunk, HeadingInfo, HeadingContext } from './types';
import { TimeoutManager } from './services/timeout-manager';
import { MicropauseService } from './services/micropause-service';
import { LIMITS } from './constants';
type HistoryEntry = { index: number; tMs: number };

/**
 * The reader's tokeniser. A token is a run of non-space characters; a run of
 * line breaks is one '\n' token. Returned as [start, end) character ranges so
 * that callers which need to know where a token came from (the Markdown
 * parser, the PDF pipeline) index into exactly the stream the engine plays.
 */
export function tokenSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      let j = i + 1;
      while (j < n && text[j] === '\n') j++;
      spans.push([i, j]);
      i = j;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      let j = i + 1;
      while (j < n && !/\s/.test(text[j])) j++;
      spans.push([i, j]);
      i = j;
    }
  }
  return spans;
}

export function tokenizeForEngine(text: string): string[] {
  return tokenSpans(String(text ?? '')).map(([a, b]) => (text[a] === '\n' ? '\n' : text.slice(a, b)));
}

export class RSVPEngine {
  private words: string[] = [];
  private currentIndex: number = 0;
  private isPlaying: boolean = false;
  private timer: number | null = null;
  private settings: FoveaFocusSettings;
  private timeoutManager: TimeoutManager;
  private micropauseService: MicropauseService;
  private onWordChange: (chunk: WordChunk) => void;
  private startTime: number = 0;
  private startWpm: number = 0;
  private pausedTime: number = 0;
  private lastPauseTime: number = 0;
  private headings: HeadingInfo[] = [];
  private wordsReadInSession: number = 0;
    // virtual-time history for time-based rewind/forward
  private history: HistoryEntry[] = [];
  private historyCursor: number = -1;
  private playbackMs: number = 0;
  private virtualTimeAtIndexMs: number[] = [];
  private virtualTotalMs: number = 0;

  private tickGen = 0;
  private nextDueMs: number | null = null;

  private static readonly MAX_HISTORY_MS = 10 * 60_000;     // keep ~10 minutes
  private static readonly MAX_HISTORY_ENTRIES = 20_000;     // safety cap
  private useMobileProfile = false;

  private nowMs(): number {
    // performance.now() is monotonic and better for scheduling; fall back to Date.now().
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  constructor(
    settings: FoveaFocusSettings,
    onWordChange: (chunk: WordChunk) => void,
    timeoutManager: TimeoutManager
  ) {
    this.settings = settings;
    this.onWordChange = onWordChange;
    this.timeoutManager = timeoutManager;
    this.micropauseService = new MicropauseService(settings, this.getEnableMicropauseSetting());
  }

  setText(text: string, startPosition?: number, startWordIndex?: number): void {
    this.words = tokenizeForEngine(text);
    this.extractHeadings();

    this.rebuildVirtualTimeline();

    // The word index wins when it is given
    if (startWordIndex !== undefined) {
      this.currentIndex = Math.max(0, Math.min(startWordIndex, this.words.length - 1));
    } else if (startPosition !== undefined && startPosition > 0) {
      // Fallback: work it out from the position (deprecated)
      const textUpToCursor = text.substring(0, startPosition);
      const wordsBeforeCursor = textUpToCursor.trim().split(/\s+/).length;
      this.currentIndex = Math.min(wordsBeforeCursor, this.words.length - 1);
    } else {
      this.currentIndex = 0;
    }
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // anchor playbackMs to this index's virtual time
  }

  setUseMobileProfile(useMobile: boolean): void {
    this.useMobileProfile = useMobile;
    this.micropauseService.updateSettings(this.settings, this.getEnableMicropauseSetting());
    this.rebuildVirtualTimeline();
  }

  play(): void {
    if (this.isPlaying) return;
    if (this.currentIndex >= this.words.length) {
      this.currentIndex = 0;
    }
    this.tickGen += 1;
    this.isPlaying = true;
    this.nextDueMs = null; // reset schedule anchor on every play/resume

    // Set the start time and the starting WPM
    if (this.startTime === 0) {
      this.startTime = Date.now();
      this.startWpm = this.getWpmSetting();
      this.wordsReadInSession = 0; // Reset slow start counter
    } else if (this.lastPauseTime > 0) {
      // On resuming after a pause, add the time spent paused
      this.pausedTime += Date.now() - this.lastPauseTime;
      this.lastPauseTime = 0;
    }

    this.displayNextWord();
  }

  pause(): void {
    this.tickGen += 1;
    this.isPlaying = false;
    if (this.timer !== null) {
      this.timeoutManager.clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextDueMs = null;
    // Record the moment of the pause
    this.lastPauseTime = Date.now();
  }

  stop(): void {
    this.pause();
    this.nextDueMs = null;
    this.currentIndex = 0;
    // Reset the times
    this.startTime = 0;
    this.pausedTime = 0;
    this.lastPauseTime = 0;
    this.startWpm = 0;
    this.wordsReadInSession = 0; // Reset slow start counter
    this.resetHistory();
  }

  reset(): void {
    this.stop();
  }

  private resetHistory(): void {
    this.history = [];
    this.historyCursor = -1;
    this.playbackMs = 0;
  }

  private getWpmAtElapsedSeconds(elapsedSec: number): number {
    if (!this.settings.enableAcceleration) return this.getWpmSetting();

    const startWpm = this.getWpmSetting(); // same as play() initial startWpm for deterministic model
    const target = this.settings.accelerationTargetWpm;
    const dur = Math.max(1, this.settings.accelerationDuration);

    if (elapsedSec >= dur) return Math.round(target);

    const progress = elapsedSec / dur;
    return Math.round(startWpm + (target - startWpm) * progress);
  }

  private rebuildVirtualTimeline(): void {
    const n = this.words.length;
    this.virtualTimeAtIndexMs = new Array(n).fill(0);
    this.virtualTotalMs = 0;
    if (n === 0) return;

    let tMs = 0;
    let sessionCount = 0;
    const SLOW_START_WORDS = 5;

    for (let i = 0; i < n; i++) {
      // record time-at-index even for linebreaks (they map to nearest time)
      this.virtualTimeAtIndexMs[i] = tMs;

      const w = this.words[i];
      if (w === '\n') continue; // playback skips these with 0 delay

      // virtual WPM from virtual time, not Date.now()
      const wpm = this.getWpmAtElapsedSeconds(tMs / 1000);
      const baseDelay = (60 / wpm) * 1000;

      let delay = baseDelay * this.pauseAt(i);

      if (this.getEnableSlowStartSetting() && sessionCount < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - sessionCount;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }

      sessionCount += 1;
      tMs += Math.max(0, delay);
    }

    this.virtualTotalMs = tMs;
  }

  private recordHistory(index: number, delayMs: number): void {
    // If user rewound and then resumes reading, discard "future" history.
    if (this.historyCursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyCursor + 1);
    }

    // If the last entry is exactly this same moment/index (e.g. after a seek anchor),
    // don't add a duplicate. Just advance time by delay.
    const last = this.history[this.history.length - 1];
    if (last && last.index === index && last.tMs === this.playbackMs) {
      this.playbackMs += Math.max(0, delayMs);
      return;
    }

    // tMs = time at which this word was displayed (virtual reading time)
    this.history.push({ index, tMs: this.playbackMs });
    this.historyCursor = this.history.length - 1;

    this.playbackMs += Math.max(0, delayMs);

    // Trim old history window
    while (
      this.history.length > RSVPEngine.MAX_HISTORY_ENTRIES ||
      (this.history.length > 0 && this.playbackMs - this.history[0].tMs > RSVPEngine.MAX_HISTORY_MS)
    ) {
      this.history.shift();
      this.historyCursor -= 1;
    }
    if (this.historyCursor < -1) this.historyCursor = -1;
  }

  private getCursorTimeMs(): number {
    if (this.history.length === 0 || this.historyCursor < 0) return 0;
    return this.history[this.historyCursor].tMs;
  }

  private findLastAtOrBefore(tMs: number): number {
    if (this.history.length === 0) return -1;
    let lo = 0, hi = this.history.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.history[mid].tMs <= tMs) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  private findFirstAtOrAfter(tMs: number): number {
    if (this.history.length === 0) return -1;
    let lo = 0, hi = this.history.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.history[mid].tMs >= tMs) { ans = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return ans;
  }

  private seekToHistoryCursor(cursor: number): void {
    if (cursor < 0 || cursor >= this.history.length) return;
    this.historyCursor = cursor;
    this.currentIndex = this.history[cursor].index;
    this.playbackMs = this.history[cursor].tMs;
  }

  private isSentenceBoundaryToken(word: string): boolean {
    if (!word) return false;
    if (word === '\n') return true;
    if (/^\[H\d\]/.test(word) || /^\[CALLOUT:/.test(word)) return true;
    return /[.!?]["')\]]?$/.test(word);
  }

  private alignToSentenceStart(index: number): number {
    let i = Math.max(0, Math.min(index, this.words.length - 1));
    while (i > 0 && !this.isSentenceBoundaryToken(this.words[i - 1])) i -= 1;
    while (i < this.words.length && this.words[i] === '\n') i += 1;
    return i;
  }

  rewind(steps: number = 20): void {
    this.moveByWords(-steps);
    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  forward(steps: number = 20): void {
    this.moveByWords(steps);
    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  private moveByWords(wordDelta: number): void {
    if (this.words.length === 0 || wordDelta === 0) return;

    let i = this.currentIndex;

    // If we're sitting on a linebreak, normalize first:
    if (wordDelta < 0) {
      while (i > 0 && this.words[i] === '\n') i -= 1;
    } else {
      while (i < this.words.length && this.words[i] === '\n') i += 1;
    }

    let remaining = Math.abs(wordDelta);

    if (wordDelta < 0) {
      // Move backward counting only non-linebreak tokens
      while (i > 0 && remaining > 0) {
        i -= 1;
        if (this.words[i] !== '\n') remaining -= 1;
      }
      // Ensure we don't end on a linebreak
      while (i > 0 && this.words[i] === '\n') i -= 1;
    } else {
      // Move forward counting only non-linebreak tokens
      while (i < this.words.length - 1 && remaining > 0) {
        i += 1;
        if (this.words[i] !== '\n') remaining -= 1;
      }
      // Ensure we don't end on a linebreak
      while (i < this.words.length - 1 && this.words[i] === '\n') i += 1;
    }

    this.currentIndex = Math.max(0, Math.min(i, this.words.length - 1));
  }

  rewindSeconds(seconds: number = 10, snapToSentence: boolean = false): void {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    const curMs =
      (this.history.length > 0 && this.historyCursor >= 0)
        ? this.history[this.historyCursor].tMs
        : (this.virtualTimeAtIndexMs[this.currentIndex] ?? 0);

    const targetMs = Math.max(0, curMs - seconds * 1000);

    const canUseHistory =
      this.history.length >= 2 &&
      this.historyCursor >= 0 &&
      this.history[0].tMs <= targetMs;

    // If history can’t reach the target (common right after heading jumps), use the virtual timeline.
    if (!canUseHistory) {
      this.currentIndex = this.findVirtualIndexAtOrBeforeMs(targetMs);
      if (snapToSentence) this.currentIndex = this.alignToSentenceStart(this.currentIndex);

      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    const cursor = this.findLastAtOrBefore(targetMs);
    if (cursor === -1) {
      // Defensive fallback (shouldn’t happen if canUseHistory is true)
      this.currentIndex = this.findVirtualIndexAtOrBeforeMs(targetMs);
      if (snapToSentence) this.currentIndex = this.alignToSentenceStart(this.currentIndex);

      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    this.seekToHistoryCursor(cursor);

    if (snapToSentence) {
      const aligned = this.alignToSentenceStart(this.currentIndex);

      // If sentence alignment goes earlier than our recorded window, fall back cleanly.
      if (this.history.length > 0 && aligned < this.history[0].index) {
        this.currentIndex = aligned;
        this.resetHistory();
        this.seedHistoryAtCurrentIndex();
      } else {
        while (this.historyCursor > 0 && this.history[this.historyCursor].index > aligned) {
          this.historyCursor -= 1;
        }
        this.currentIndex = aligned;
        this.playbackMs = this.history[this.historyCursor]?.tMs ?? (this.virtualTimeAtIndexMs[this.currentIndex] ?? 0);
      }
    }

    if (wasPlaying) this.play();
    else this.displayCurrentWord();
  }

  forwardSeconds(seconds: number = 10): void {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    // If history is empty/too short (e.g. just jumped), seek via the virtual timeline.
    if (this.history.length < 2) {
      const curMs = this.virtualTimeAtIndexMs[this.currentIndex] ?? 0;
      const targetMs = curMs + seconds * 1000;
      this.currentIndex = this.findVirtualIndexAtOrAfterMs(targetMs);
    
      this.resetHistory();
      this.seedHistoryAtCurrentIndex();

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    // If we rewound into the past, move forward within recorded history (undo seek)
    if (this.history.length > 0 && this.historyCursor >= 0 && this.historyCursor < this.history.length - 1) {
      const target = this.getCursorTimeMs() + seconds * 1000;
      const nextCursor = this.findFirstAtOrAfter(target);
      this.seekToHistoryCursor(nextCursor !== -1 ? nextCursor : this.history.length - 1);

      if (wasPlaying) this.play();
      else this.displayCurrentWord();
      return;
    }

    // Otherwise simulate forward using the same delay rules (micropause + accel + slow start)
    let acc = 0;
    let i = this.currentIndex;
    let sessionCount = this.wordsReadInSession;
    const SLOW_START_WORDS = 5;

    while (i < this.words.length && acc < seconds * 1000) {
      if (this.words[i] === '\n') { i += 1; continue; }

      let delay = this.getChunk(i).delay;

      if (this.getEnableSlowStartSetting() && sessionCount < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - sessionCount;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }

      acc += delay;
      sessionCount += 1;
      i += 1;
    }

    this.currentIndex = Math.min(this.words.length - 1, i);

    // Preserve history so rewind still works after a forward jump.
    // We "anchor" the new position at (old playbackMs + acc).
    const newT = this.playbackMs + acc;

    // If we were in the past (shouldn't happen in this branch), discard future.
    if (this.historyCursor < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyCursor + 1);
    }

    this.playbackMs = newT;

    // Add an anchor entry at the new position/time
    this.history.push({ index: this.currentIndex, tMs: this.playbackMs });
    this.historyCursor = this.history.length - 1;

    // Trim window
    while (
      this.history.length > RSVPEngine.MAX_HISTORY_ENTRIES ||
      (this.history.length > 0 && this.playbackMs - this.history[0].tMs > RSVPEngine.MAX_HISTORY_MS)
    ) {
      this.history.shift();
      this.historyCursor -= 1;
    }
    if (this.historyCursor < -1) this.historyCursor = -1;

    if (wasPlaying) this.play();
    else this.displayCurrentWord();
  }

  private getWpmSetting(): number {
    return this.useMobileProfile ? this.settings.mobileWpm : this.settings.wpm;
  }
  private setWpmSetting(v: number): void {
    if (this.useMobileProfile) this.settings.mobileWpm = v;
    else this.settings.wpm = v;
  }

  private getChunkSizeSetting(): number {
    return this.useMobileProfile ? this.settings.mobileChunkSize : this.settings.chunkSize;
  }
  private setChunkSizeSetting(v: number): void {
    if (this.useMobileProfile) this.settings.mobileChunkSize = v;
    else this.settings.chunkSize = v;
  }

  private getEnableSlowStartSetting(): boolean {
    return this.useMobileProfile ? this.settings.mobileEnableSlowStart : this.settings.enableSlowStart;
  }
  private getEnableMicropauseSetting(): boolean {
    return this.useMobileProfile ? this.settings.mobileEnableMicropause : this.settings.enableMicropause;
  }

  private displayCurrentWord(): void {
    while (this.currentIndex < this.words.length && this.words[this.currentIndex] === '\n') {
      this.currentIndex += 1;
    }
    if (this.currentIndex >= this.words.length) {
      return;
    }

    const chunk = this.getChunk(this.currentIndex);
    this.onWordChange(chunk);
  }

  private displayNextWord(): void {
    if (!this.isPlaying) return;

    const gen = this.tickGen;

    // Skip linebreak tokens so we always advance through real words
    while (this.currentIndex < this.words.length && this.words[this.currentIndex] === '\n') {
      this.currentIndex += 1;
    }

    if (this.currentIndex >= this.words.length) {
      this.isPlaying = false;
      return;
    }

    const chunk = this.getChunk(this.currentIndex);
    this.onWordChange(chunk);

    let delay = chunk.delay;

    if (this.getEnableSlowStartSetting()) {
      const SLOW_START_WORDS = 5;
      if (this.wordsReadInSession < SLOW_START_WORDS) {
        const remainingSlowWords = SLOW_START_WORDS - this.wordsReadInSession;
        const slowStartMultiplier = 1 + (remainingSlowWords / SLOW_START_WORDS);
        delay *= slowStartMultiplier;
      }
    }

    this.wordsReadInSession += 1;

    // record the *actual* scheduled delay for time-based seeking
    this.recordHistory(this.currentIndex, delay);

    // CRITICAL: advance by ONE token every tick (not chunkSize)
    this.currentIndex += 1;

    const now = this.nowMs();
    const delayMs = Math.max(0, delay);

    // Initialise anchor on first tick after play()
    if (this.nextDueMs == null) this.nextDueMs = now;

    // Set the next due-time based on intended delay
    this.nextDueMs += delayMs;

    let waitMs = this.nextDueMs - now;

    // If we’re massively behind (tab stall / throttling), resync to avoid turbo bursts.
    if (waitMs < -250) {
      this.nextDueMs = now + delayMs;
      waitMs = delayMs;
    }

    this.timer = this.timeoutManager.setTimeout(() => {
      if (gen !== this.tickGen) return; // stale callback; ignore
      this.displayNextWord();
    }, Math.max(0, waitMs));
  }

  /**
   * For the word on show while the reading runs, when it is shown in parts: how long each
   * part is on show, in milliseconds. The parts share what is left of the word's time by
   * the shares given. None is on show for less than a plain word is at this speed: the
   * word is held for as much longer as that takes.
   */
  timesOfParts(shares: number[]): number[] {
    if (!this.isPlaying || this.timer === null || this.nextDueMs === null) return [];

    const left = Math.max(0, this.nextDueMs - this.nowMs());
    const all = shares.reduce((sum, share) => sum + share, 0);
    const least = (60 / this.getCurrentWpm()) * 1000;
    const times = shares.map((share) => Math.max((left * share) / all, least));
    const longer = times.reduce((sum, time) => sum + time, 0) - left;

    if (longer >= 1) {
      const gen = this.tickGen;
      this.timeoutManager.clearTimeout(this.timer);
      this.nextDueMs += longer;
      this.playbackMs += longer;
      this.timer = this.timeoutManager.setTimeout(() => {
        if (gen !== this.tickGen) return;
        this.displayNextWord();
      }, left + longer);
    }
    return times;
  }

  private getChunk(startIndex: number): WordChunk {
    const chunkSize = Math.max(1, this.getChunkSizeSetting() || 1);

    const chunkWords: string[] = [];
    let i = startIndex;

    while (i < this.words.length && chunkWords.length < chunkSize) {
      const w = this.words[i];
      if (w !== '\n') chunkWords.push(w);
      i++;
    }

    const text = chunkWords.join(' ');

    const delay = this.calculateDelay(startIndex);

    return {
      text,
      index: startIndex,
      delay,
      isEnd: startIndex >= this.words.length - 1,
      title: this.titleAt(startIndex),
      headingContext: this.getCurrentHeadingContext(startIndex)
    };
  }

  /**
   * The heading or callout title a word is part of. A title runs from its marker to the end
   * of its line, so every word of that line belongs to it, not the marked one alone.
   */
  private titleAt(index: number): WordChunk['title'] {
    let first = index;
    while (first > 0 && this.words[first - 1] !== '\n') first -= 1;

    const heading = /^\[H(\d)\]/.exec(this.words[first] ?? '');
    if (heading) return { level: parseInt(heading[1]) };
    const callout = /^\[CALLOUT:([\w-]+)\]/.exec(this.words[first] ?? '');
    return callout ? { level: 0, calloutType: callout[1] } : undefined;
  }

  private getCurrentWpm(): number {
    // With acceleration off, return the normal WPM
    if (!this.settings.enableAcceleration || this.startTime === 0) {
      return this.getWpmSetting();
    }

    // Elapsed time, in seconds
    const now = this.isPlaying ? Date.now() : (this.lastPauseTime || Date.now());
    const elapsed = (now - this.startTime - this.pausedTime) / 1000;

    // Past the acceleration period, return the target WPM
    if (elapsed >= this.settings.accelerationDuration) {
      return this.settings.accelerationTargetWpm;
    }

    // The WPM part-way through the ramp
    const progress = elapsed / this.settings.accelerationDuration;
    const wpmDiff = this.settings.accelerationTargetWpm - this.startWpm;
    const currentWpm = this.startWpm + (wpmDiff * progress);

    return Math.round(currentWpm);
  }

  private calculateDelay(index: number): number {
    const currentWpm = this.getCurrentWpm();
    const baseDelay = (60 / currentWpm) * 1000;

    return baseDelay * this.pauseAt(index);
  }

  /**
   * By how much the pauses lengthen the word at an index. The pauses are told what stands
   * round the word: a line break after it counts with it, so that the pause between
   * paragraphs falls on the last word of one, and they are given the word that follows on
   * the line and whether the word is the first of its line.
   */
  private pauseAt(index: number): number {
    const word = this.words[index] ?? '';
    const endsLine = this.words[index + 1] === '\n';
    const next = endsLine ? '' : this.words[index + 1] ?? '';
    const startsLine = index === 0 || this.words[index - 1] === '\n';
    return this.micropauseService.calculateMultiplier(endsLine ? `${word}\n` : word, next, startsLine);
  }

  /**
   * Collect headings ("[H2]Title ...") and callout titles ("[CALLOUT:note]Title ...")
   * with the index of the token each one starts at. A title runs to the end of its line.
   */
  private extractHeadings(): void {
    this.headings = [];
    const MAX_TITLE_WORDS = 20;
    /** Levels of the headings the next one may be nested under. */
    const open: number[] = [];
    const isMarker = (w: string): boolean => /^\[H\d\]/.test(w) || /^\[CALLOUT:/.test(w);

    for (let i = 0; i < this.words.length; i++) {
      const word = this.words[i];
      const heading = /^\[H(\d)\](.*)/.exec(word);
      const callout = heading ? null : /^\[CALLOUT:([\w-]+)\](.*)/.exec(word);
      if (!heading && !callout) continue;

      const titleWords = [(heading ?? callout)![2]].filter(Boolean);
      for (let j = i + 1; j < this.words.length && titleWords.length < MAX_TITLE_WORDS; j++) {
        const next = this.words[j];
        if (next === '\n' || isMarker(next)) break;
        titleWords.push(next);
      }

      // Callouts rank below H6 so they nest under whatever heading they sit in.
      const level = heading ? parseInt(heading[1]) : 7;
      // Depth follows the nesting, not the level: an H3 straight under an H1 is one step in.
      while (open.length && open[open.length - 1] >= level) open.pop();
      this.headings.push({
        level,
        depth: open.length,
        text: titleWords.join(' ').trim(),
        wordIndex: i,
        ...(callout ? { calloutType: callout[1] } : {}),
      });
      open.push(level);
    }
  }

  /**
   * Get the current heading context (the path of headings) for a given word index
   * Returns the hierarchical path of headings leading to the current position
   *
   * @param wordIndex - Word index to get context for
   * @returns Heading context with the path of headings and the current heading
   */
  getCurrentHeadingContext(wordIndex: number): HeadingContext {
    if (this.headings.length === 0) {
      return { path: [], current: null };
    }

    // Find all headings before or at the current position
    const relevantHeadings = this.headings.filter(h => h.wordIndex <= wordIndex);

    if (relevantHeadings.length === 0) {
      return { path: [], current: null };
    }

    // Build the path of headings, outermost first
    const path: HeadingInfo[] = [];
    let currentLevel = 0;

    for (const heading of relevantHeadings) {
      // If this heading is at a lower or equal level than current, reset the path up to this level
      if (heading.level <= currentLevel) {
        // Remove all headings from this level onwards
        while (path.length > 0 && path[path.length - 1].level >= heading.level) {
          path.pop();
        }
      }

      path.push(heading);
      currentLevel = heading.level;
    }

    return {
      path,
      current: path[path.length - 1] || null
    };
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getTotalWords(): number {
    return this.words.length;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  setWpm(wpm: number): void {
    this.setWpmSetting(Math.max(LIMITS.wpm.min, Math.min(LIMITS.wpm.max, wpm)));
    this.rebuildVirtualTimeline();
  }

  getWpm(): number {
    return this.getWpmSetting();
  }

  setChunkSize(size: number): void {
    this.setChunkSizeSetting(Math.max(LIMITS.chunkSize.min, Math.min(LIMITS.chunkSize.max, size)));
  }

  getChunkSize(): number {
    return this.getChunkSizeSetting();
  }

  // ---------------------------------------------------------------------------
  // Line-based context (replaces old word-based context)
  // ---------------------------------------------------------------------------

  /**
   * Returns a token window around the current word for UI-level (wrapped) context rendering.
   * Includes explicit line break tokens ('\n') and internal markers; the view layer formats it.
   */
  public getContextTokenWindow(
    index: number,
    backTokens: number,
    forwardTokens: number
  ): { before: string[]; after: string[] } {
    const len = this.words.length;
    if (len === 0) return { before: [], after: [] };

    const idx = Math.max(0, Math.min(index, len - 1));
    const back = Math.max(0, Math.floor(backTokens));
    const fwd = Math.max(0, Math.floor(forwardTokens));
  
    const start = Math.max(0, idx - back);

    // BEFORE: exclude the focused word; trim trailing line breaks
    const before = this.words.slice(start, idx);
    while (before.length && before[before.length - 1] === '\n') before.pop();

    // AFTER: start immediately after the focused word (NOT after the full displayed chunk)
    let afterStart = Math.min(len, idx + 1);
    while (afterStart < len && this.words[afterStart] === '\n') afterStart += 1;

    const end = Math.min(len, afterStart + fwd);
    const after = this.words.slice(afterStart, end);

    return { before, after };
  }

  /**
   * How long each word is held, in milliseconds, by the model the time estimates go by: the
   * speed, the pauses, the slow start and the acceleration. A line break is held for no time.
   */
  public getWordDurationsMs(): number[] {
    return this.virtualTimeAtIndexMs.map((at, index) => (this.virtualTimeAtIndexMs[index + 1] ?? this.virtualTotalMs) - at);
  }

  public getVirtualTotalSeconds(): number {
    return Math.round(this.virtualTotalMs / 1000);
  }

  public getVirtualElapsedSecondsAtCurrentIndex(): number {
    if (this.words.length === 0) return 0;
    const idx = Math.max(0, Math.min(this.currentIndex, this.words.length - 1));
    return Math.round((this.virtualTimeAtIndexMs[idx] || 0) / 1000);
  }

  public getVirtualRemainingSeconds(): number {
    const total = this.getVirtualTotalSeconds();
    const elapsed = this.getVirtualElapsedSecondsAtCurrentIndex();
    return Math.max(0, total - elapsed);
  }

  public getVirtualElapsedSecondsAtIndex(index: number): number {
    if (this.words.length === 0) return 0;
    const idx = Math.max(0, Math.min(index, this.words.length - 1));
    return Math.round((this.virtualTimeAtIndexMs[idx] || 0) / 1000);
  }

  private findVirtualIndexAtOrBeforeMs(tMs: number): number {
    const n = this.words.length;
    if (n === 0) return 0;

    let lo = 0, hi = n - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.virtualTimeAtIndexMs[mid] <= tMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  private findVirtualIndexAtOrAfterMs(tMs: number): number {
    const n = this.words.length;
    if (n === 0) return 0;

    let lo = 0, hi = n - 1, ans = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.virtualTimeAtIndexMs[mid] >= tMs) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return ans;
  }

  private seedHistoryAtCurrentIndex(): void {
    const tMs = this.virtualTimeAtIndexMs[this.currentIndex] ?? 0;
    this.playbackMs = tMs;
    this.history = [{ index: this.currentIndex, tMs }];
    this.historyCursor = 0;
  }

  updateSettings(settings: FoveaFocusSettings): void {
    this.settings = settings;
    this.micropauseService.updateSettings(settings, this.getEnableMicropauseSetting());
    this.rebuildVirtualTimeline();
  }

  getRemainingWords(): number {
    // Words left to read
    return Math.max(0, this.words.length - this.currentIndex);
  }

  /**
   * Returns all headings extracted from the document
   * Useful for navigation and section counting
   */
  getHeadings(): HeadingInfo[] {
    return this.headings;
  }

  jumpToIndex(index: number): void {
    if (this.words.length === 0) return;

    this.currentIndex = Math.max(0, Math.min(index, this.words.length - 1));
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // ensures rewind works immediately after a jump

    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  /**
   * Move by N real words (skipping '\n' tokens).
   * Negative = backward, positive = forward.
   * Keeps behavior consistent with jumpToIndex() (updates display / restarts timer if playing).
   */
  stepWords(wordDelta: number): void {
    if (this.words.length === 0 || wordDelta === 0) return;

    this.moveByWords(wordDelta);
    this.resetHistory();
    this.seedHistoryAtCurrentIndex(); // keep playbackMs consistent after wheel-stepping

    if (this.isPlaying) {
      this.pause();
      this.play();
    } else {
      this.displayCurrentWord();
    }
  }

  jumpToStart(): void {
    this.jumpToIndex(0);
  }

  jumpToEnd(): void {
    this.jumpToIndex(this.words.length - 1);
  }
}
