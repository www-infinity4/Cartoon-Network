(function (root) {
  "use strict";

  // One Central broadcast clock keeps every live viewer on the same cartoon.
  // UI code may still format these absolute timestamps in each viewer's local timezone.
  const TIME_ZONE = (Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago");
  const BLOCK_SECONDS = 1800;
  const BREAK_AFTER_CONTENT_SECONDS = [660];
  const SPOTS_PER_BREAK = 3;
  const DEFAULT_SPOT_SECONDS = 60;

  function stationParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
  }

  function zonedToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = target;
    for (let i = 0; i < 4; i += 1) {
      const p = stationParts(new Date(guess));
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += target - represented;
    }
    return guess;
  }

  function dateKey(nowMs) {
    const p = stationParts(new Date(nowMs));
    return `${p.year}-${String(p.month).padStart(2,"0")}-${String(p.day).padStart(2,"0")}`;
  }

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return value >>> 0;
  }

  function seededShuffle(items, seedText) {
    const copy = items.slice();
    let seed = hash(seedText);
    const random = () => {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function createDaySchedule(nowMs, catalog) {
    const p = stationParts(new Date(nowMs));
    const midnightMs = zonedToUtc(p.year, p.month, p.day);
    const eligible = catalog.filter(movie => movie.cleared && movie.videoId);
    if (!eligible.length) throw new Error("Cartoon Network has no playable cartoons configured.");
    const todayKey = dateKey(nowMs);
    const slotCount = 48;
    const epochDay = Math.floor(midnightMs / 86400000);
    const weekNumber = Math.floor(epochDay / 7);
    const cycle = seededShuffle(eligible, `infinity-cartoon-week-v2:${weekNumber}`);
    const start = ((epochDay * slotCount) % cycle.length + cycle.length) % cycle.length;
    const featured = Array.from({length:48}, (_, index) => cycle[(start + index) % cycle.length]);
    return featured.map((movie, index) => ({
      id: `${todayKey}-${String(index).padStart(2,"0")}`,
      movie,
      startsAtMs: midnightMs + index * BLOCK_SECONDS * 1000,
      endsAtMs: midnightMs + (index + 1) * BLOCK_SECONDS * 1000,
      blockSeconds: BLOCK_SECONDS
    }));
  }

  function createSegments(block, commercials) {
    const runtime = Math.min(block.movie.runtimeSeconds || 1320, BLOCK_SECONDS - 180);
    const boundaries = [0, ...BREAK_AFTER_CONTENT_SECONDS.filter(n => n < runtime), runtime];
    const ads = Array.isArray(commercials) ? commercials : [];
    const segments = [];
    let stationOffset = 0;
    let adIndex = 0;

    function pushSegment(segment, requestedDuration) {
      const remaining = BLOCK_SECONDS - stationOffset;
      if (remaining <= 0) return false;
      const duration = Math.min(Math.max(1, requestedDuration), remaining);
      segments.push({...segment, stationStart:stationOffset, duration});
      stationOffset += duration;
      return duration === requestedDuration;
    }

    outer:
    for (let i = 0; i < boundaries.length - 1; i++) {
      const sourceStart = boundaries[i];
      if (!pushSegment({kind:"movie", title:block.movie.title, videoId:block.movie.videoId, cleared:block.movie.cleared, sourceStart}, boundaries[i + 1] - sourceStart)) break;
      if (i < boundaries.length - 2) {
        for (let spot = 0; spot < SPOTS_PER_BREAK; spot++) {
          const ad = ads.length ? (ads[adIndex++ % ads.length] || {}) : {title:"Cartoon Network station break", durationSeconds:DEFAULT_SPOT_SECONDS, videoId:"", cleared:false};
          if (!pushSegment({kind:"commercial", title:ad.title || "Cartoon Network station break", videoId:ad.videoId || "", cleared:!!ad.cleared, sourceStart:0}, ad.durationSeconds || DEFAULT_SPOT_SECONDS)) break outer;
        }
      }
    }

    if (stationOffset < BLOCK_SECONDS) {
      pushSegment({kind:"station", title:"Next cartoon at the half hour", videoId:"", cleared:true, sourceStart:0}, BLOCK_SECONDS - stationOffset);
    }
    return segments;
  }

  function resolve(nowMs, schedule, commercials) {
    const block = schedule.find(item => nowMs >= item.startsAtMs && nowMs < item.endsAtMs) || schedule[0];
    const blockElapsed = Math.max(0, Math.floor((nowMs - block.startsAtMs) / 1000));
    const segments = createSegments(block, commercials);
    const segment = segments.find(item => blockElapsed >= item.stationStart && blockElapsed < item.stationStart + item.duration) || segments[segments.length - 1];
    const segmentElapsed = Math.max(0, blockElapsed - segment.stationStart);
    const segmentIndex = segments.indexOf(segment);
    let movieReturnsIn = segment.duration - segmentElapsed;
    for (let i = segmentIndex + 1; segment.kind === "commercial" && i < segments.length && segments[i].kind === "commercial"; i++) movieReturnsIn += segments[i].duration;
    return {
      block, segment, segmentElapsed, blockElapsed,
      mediaSeconds: segment.sourceStart + segmentElapsed,
      segmentRemaining: Math.max(0, segment.duration - segmentElapsed),
      movieReturnsIn: Math.max(0, movieReturnsIn),
      blockRemaining: Math.max(0, block.blockSeconds - blockElapsed)
    };
  }

  root.HermitEngine = { TIME_ZONE, BLOCK_SECONDS, stationParts, zonedToUtc, dateKey, createDaySchedule, createSegments, resolve };
})(window);
