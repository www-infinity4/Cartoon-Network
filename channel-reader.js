(function(g){"use strict";
const API="https://tv-database.marvaseater.workers.dev";
function id(v){return /^[A-Za-z0-9_-]{6,15}$/.test(String(v||""))?String(v):""}
async function get(channel){
  const r=await fetch(API+"/v1/now/"+encodeURIComponent(channel),{cache:"no-store"});
  if(!r.ok)throw new Error("schedule_"+r.status);
  const x=await r.json();
  if(!x.ok||!x.now||!id(x.now.source&&x.now.source.sourceId))throw new Error("no_remote_program");
  return x;
}
function managedPlayer(){
  return Boolean(g.YT||g.onYouTubeIframeAPIReady||document.querySelector('script[src*="iframe_api"]'));
}
async function start(channel){
  try{
    const x=await get(channel),p=x.now,vid=id(p.source.sourceId);
    g.INFINITY_REMOTE_NOW=x;
    g.dispatchEvent(new CustomEvent("infinity:schedule-now",{detail:x}));
    const title=document.getElementById("nowTitle")||document.getElementById("title");
    if(title)title.textContent=p.title;

    // Never destroy a channel-owned YT.Player. The channel app owns playback;
    // this reader owns schedule state. Managed players consume the event above.
    if(managedPlayer()) return x;

    const host=document.getElementById("player");
    if(host&&vid){
      const sec=Math.max(0,Number(x.offsetSeconds||0));
      const src="https://www.youtube.com/embed/"+vid+"?playsinline=1&controls=1&start="+sec;
      const old=host.querySelector("iframe");
      if(!old||!old.src.includes("/"+vid+"?")){
        host.innerHTML="";
        const f=document.createElement("iframe");
        f.src=src;
        f.allow="autoplay; encrypted-media; picture-in-picture";
        f.allowFullscreen=true;
        f.title=p.title;
        host.appendChild(f);
      }
    }
    return x;
  }catch(e){
    console.warn("[Channel Creatir reader] local fallback:",e.message);
    return null;
  }
}
g.InfinityChannelReader={api:API,get,start};
})(window);
