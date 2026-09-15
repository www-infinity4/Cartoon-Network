(function (root) {
  "use strict";

  const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  const BLOCK_SECONDS = 1800;
  const MIN_FULL_EPISODE_SECONDS = 900;

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

  function mondayIndex(nowMs) {
    const weekday = new Intl.DateTimeFormat("en-US", {timeZone:TIME_ZONE,weekday:"short"}).format(new Date(nowMs));
    return ({Mon:0,Tue:1,Wed:2,Thu:3,Fri:4,Sat:5,Sun:6})[weekday] ?? 0;
  }

  function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    return value >>> 0;
  }

  function seededShuffle(items, seedText) {
    if (root.InfinityChannelPolicy) return root.InfinityChannelPolicy.seededShuffle(items, seedText);
    const copy = items.slice();
    let seed = hash(seedText);
    const random = () => {
      seed += 0x6D2B79F5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function eligiblePrograms(catalog) {
    if (root.InfinityChannelPolicy) {
      return root.InfinityChannelPolicy.eligiblePrograms(catalog, {
        slotSeconds: BLOCK_SECONDS,
        minRuntimeSeconds: MIN_FULL_EPISODE_SECONDS
      });
    }
    const seen = new Set();
    return (Array.isArray(catalog) ? catalog : []).filter(item => {
      if (!item || !item.cleared || !item.videoId || Number(item.runtimeSeconds || 0) < MIN_FULL_EPISODE_SECONDS) return false;
      if (seen.has(item.videoId)) return false;
      seen.add(item.videoId);
      return true;
    });
  }

  function createDaySchedule(nowMs, catalog) {
    const p = stationParts(new Date(nowMs));
    const midnightMs = zonedToUtc(p.year, p.month, p.day);
    const eligible = eligiblePrograms(catalog);
    const todayKey = dateKey(nowMs);
    const slotCount = 48;
    const epochDay = Math.floor(midnightMs / 86400000);
    const dayOfDeck = mondayIndex(nowMs);
    const mondayEpochDay = epochDay - dayOfDeck;
    const weekNumber = Math.floor(mondayEpochDay / 7);
    const cycle = seededShuffle(eligible, `cartoon-network-seven-day:${weekNumber}:${eligible.map(x => x.videoId).sort().join("|")}`);
    const dayOffset = cycle.length ? (dayOfDeck * 13) % cycle.length : 0;
    return Array.from({length:slotCount}, (_, index) => {
      const movie = cycle.length ? cycle[(dayOffset + index) % cycle.length] : {
        id:`CN-EMPTY-${todayKey}-${index}`,
        title:"Cartoon source unavailable",
        year:"",
        collection:"No usable full episode exists in the catalog",
        runtimeSeconds:BLOCK_SECONDS,
        videoId:"",
        cleared:false
      };
      return {
        id: `${todayKey}-${String(index).padStart(2,"0")}`,
        movie,
        startsAtMs: midnightMs + index * BLOCK_SECONDS * 1000,
        endsAtMs: midnightMs + (index + 1) * BLOCK_SECONDS * 1000,
        blockSeconds: BLOCK_SECONDS
      };
    });
  }

  function playableAds(commercials) {
    return (Array.isArray(commercials) ? commercials : []).filter(ad => ad && ad.cleared && ad.videoId && Number(ad.durationSeconds || 0) > 0);
  }

  function createSegments(block, commercials) {
    if (!block || !block.movie) return [];
    const runtime = Math.min(Math.max(1, Number(block.movie.runtimeSeconds) || BLOCK_SECONDS), BLOCK_SECONDS);
    const ads = playableAds(commercials);
    const policy = root.InfinityChannelPolicy;
    const breaks = ads.length && runtime >= MIN_FULL_EPISODE_SECONDS
      ? (policy ? policy.staggeredBreaks({channelId:"Cartoon-Network",blockId:block.id,dateKey:block.id.slice(0,10),runtimeSeconds:runtime,blockSeconds:BLOCK_SECONDS,count:1,edgeSeconds:300}) : [])
      : [];
    const boundaries = [0, ...breaks.filter(n => n > 0 && n < runtime), runtime];
    const segments = [];
    let stationOffset = 0;
    let adIndex = 0;

    function push(segment, requested) {
      const remaining = BLOCK_SECONDS - stationOffset;
      if (remaining <= 0) return false;
      const duration = Math.min(Math.max(1, Math.floor(requested)), remaining);
      segments.push({...segment, stationStart:stationOffset, duration});
      stationOffset += duration;
      return duration === requested;
    }

    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const sourceStart = boundaries[i];
      if (!push({kind:"movie",title:block.movie.title,videoId:block.movie.videoId,cleared:block.movie.cleared,sourceStart}, boundaries[i + 1] - sourceStart)) break;
      if (i < boundaries.length - 2 && ads.length) {
        const ad = ads[adIndex++ % ads.length];
        push({kind:"commercial",title:ad.title || "Cartoon Network break",videoId:ad.videoId,cleared:true,sourceStart:0}, Math.min(90, Number(ad.durationSeconds) || 30));
      }
    }

    if (stationOffset < BLOCK_SECONDS) {
      push({kind:"station",title:"Next cartoon at the half hour",videoId:"",cleared:true,sourceStart:0}, BLOCK_SECONDS - stationOffset);
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
    for (let i = segmentIndex + 1; segment && segment.kind === "commercial" && i < segments.length && segments[i].kind === "commercial"; i += 1) movieReturnsIn += segments[i].duration;
    return {
      block, segment, segmentElapsed, blockElapsed,
      mediaSeconds: segment.sourceStart + segmentElapsed,
      segmentRemaining: Math.max(0, segment.duration - segmentElapsed),
      movieReturnsIn: Math.max(0, movieReturnsIn),
      blockRemaining: Math.max(0, block.blockSeconds - blockElapsed)
    };
  }

  root.HermitEngine = { TIME_ZONE, BLOCK_SECONDS, MIN_FULL_EPISODE_SECONDS, stationParts, zonedToUtc, dateKey, createDaySchedule, createSegments, resolve };
})(window);