import { useState, useEffect, useCallback } from "react";

// ─── Persistent Storage ───────────────────────────────────────────────────────
const useStore = (key, def) => {
  const [v, setV] = useState(() => { try { const s=localStorage.getItem(key); return s?JSON.parse(s):def; } catch{return def;} });
  const set = useCallback(fn => {
    setV(prev => {
      const next = typeof fn==="function" ? fn(prev) : fn;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch{}
      return next;
    });
  }, [key]);
  return [v, set];
};

// ─── ICAO DB ──────────────────────────────────────────────────────────────────
const ICAO_DB = {
  RKSI:"인천국제공항",RKSS:"김포국제공항",RKPC:"제주국제공항",RKTN:"대구국제공항",
  RKTU:"청주국제공항",RKJJ:"광주공항",RKJK:"군산공항",RKPS:"사천공항",RKTH:"포항경주",
  RJTT:"도쿄 하네다",RJAA:"도쿄 나리타",RJOO:"오사카 이타미",RJBB:"오사카 간사이",
  RJFF:"후쿠오카",RJCC:"삿포로",ZGGG:"광저우",ZBAA:"베이징 캐피탈",ZSSS:"상하이 훙차오",
  ZSPD:"상하이 푸둥",VHHH:"홍콩",RCTP:"타이베이 타오위안",VTBS:"방콕 수완나품",
  WSSS:"싱가포르 창이",WMKK:"쿠알라룸푸르",WADD:"발리",OMDB:"두바이",OTHH:"도하 하마드",
  EGLL:"런던 히드로",LFPG:"파리 드골",EDDF:"프랑크푸르트",EHAM:"암스테르담 스키폴",
  KLAX:"로스앤젤레스",KJFK:"뉴욕 JFK",KORD:"시카고 오헤어",KSFO:"샌프란시스코",
  KATL:"애틀란타",KDFW:"댈러스",CYYZ:"토론토 피어슨",YSSY:"시드니",YMML:"멜버른",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const decHrs = (dep,arr) => {
  if(!dep||!arr) return 0;
  const [dh,dm]=dep.split(":").map(Number), [ah,am]=arr.split(":").map(Number);
  let m=ah*60+am-(dh*60+dm); if(m<0)m+=1440;
  return Math.round(m/60*100)/100;
};
const fmtH = (dec) => { const h=Math.floor(dec||0),m=Math.round(((dec||0)-h)*60); return `${h}:${String(m).padStart(2,"0")}`; };
const fmt1 = (n) => (+(n||0)).toFixed(1);
const today = () => new Date().toISOString().slice(0,10);
const daysAgo = (n) => { const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); };

// ─── Time Utilities ───────────────────────────────────────────────────────────
// Ramp Out/In: 항상 UTC로 저장·계산 (비행근무시간 규정 기준)
// 야간수당:    UTC → KST(+09:00) 변환 후 22:00~06:00 구간 계산

const KST_OFFSET = 9 * 60; // KST = UTC + 9h (분 단위)

const timeToMins = (hhmm) => {
  if(!hhmm) return null;
  const [h,m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// UTC 분 위치를 KST 분 위치로 변환 (0~1439 범위 유지)
const utcMinsToKst = (utcMins) => (utcMins + KST_OFFSET) % 1440;

// UTC 기준 startMins에서 durationMins 동안 KST 야간(22:00~06:00) 겹치는 분 수
const calcNightMinsKST = (utcStartMins, durationMins) => {
  // KST 야간: 22:00(1320)~24:00(1440) + 00:00(0)~06:00(360)
  const NIGHT_KST = [[0, 360], [1320, 1440]];
  let night = 0;
  for (let i = 0; i < durationMins; i++) {
    const kst = (utcStartMins + i + KST_OFFSET) % 1440;
    if (NIGHT_KST.some(([s,e]) => kst >= s && kst < e)) night++;
  }
  return night;
};

// FDP 한도 테이블 (ICAO Annex 6 / 항공안전법 시행규칙 별표 12 기준)
// crew: 2=기본 2인, 3=강화 3인(3-pilot), 4=강화 4인(augmented)
// 장거리 운항 기준 (단일구간, 적정 휴식 후 출발)
const FDP_LIMITS = {
  2: 13,   // 2인 승무: 최대 13:00
  3: 15,   // 3인 승무(강화): 최대 15:00 (RP 포함)
  4: 18,   // 4인 승무(완전 강화): 최대 18:00
};
const FDP_LABEL = {
  2: "2인 승무 (기본)",
  3: "3인 승무 (강화)",
  4: "4인 승무 (완전 강화)",
};

const getFdpLimit = (crew) => FDP_LIMITS[crew] || FDP_LIMITS[2];

const calcRamp = (flight) => {
  const roUtc = timeToMins(flight.rampOutUtc);
  const riUtc = timeToMins(flight.rampInUtc);
  if (roUtc === null || riUtc === null) return null;

  let rampMins = riUtc - roUtc;
  if (rampMins <= 0) rampMins += 1440; // UTC 날짜 넘김

  const rampHrs   = rampMins / 60;
  const nightMins = calcNightMinsKST(roUtc, rampMins);
  const nightHrs  = nightMins / 60;
  const overtimeHrs = Math.max(0, rampHrs - 8);

  const crew = parseInt(flight.crew) || 4; // 기본값 4인 (장거리 주력)
  const fdpLimit = getFdpLimit(crew);
  const fdpExceeds = rampHrs > fdpLimit;

  // KST 표시용
  const roKst = utcMinsToKst(roUtc);
  const riKst = utcMinsToKst(riUtc);
  const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;

  return {
    rampHrs, nightHrs, overtimeHrs, rampMins,
    roUtcStr: flight.rampOutUtc,
    riUtcStr: flight.rampInUtc,
    roKstStr: toHHMM(roKst),
    riKstStr: toHHMM(riKst),
    fdpLimit, fdpExceeds, crew,
    fdpPct: Math.min(100, rampHrs / fdpLimit * 100),
  };
};

const calcPay = (flight, hourlyRate) => {
  if (!hourlyRate || hourlyRate <= 0) return null;
  const r = calcRamp(flight);
  if (!r) return null;

  const { rampHrs, nightHrs, overtimeHrs } = r;
  const basePay     = rampHrs * hourlyRate;
  const nightPay    = nightHrs * hourlyRate * 0.5;
  const overtimePay = overtimeHrs * hourlyRate * 0.5;
  const totalPay    = basePay + nightPay + overtimePay;

  return { ...r, basePay, nightPay, overtimePay, totalPay };
};

const calcMonthPay = (flights, hourlyRate) => {
  const months = {};
  flights.forEach(f => {
    const p = calcPay(f, hourlyRate);
    if (!p) return;
    const m = f.date.slice(0,7);
    if (!months[m]) months[m] = {rampHrs:0,nightHrs:0,overtimeHrs:0,basePay:0,nightPay:0,overtimePay:0,totalPay:0,count:0};
    months[m].rampHrs     += p.rampHrs;
    months[m].nightHrs    += p.nightHrs;
    months[m].overtimeHrs += p.overtimeHrs;
    months[m].basePay     += p.basePay;
    months[m].nightPay    += p.nightPay;
    months[m].overtimePay += p.overtimePay;
    months[m].totalPay    += p.totalPay;
    months[m].count++;
  });
  return months;
};

// FDP 준수 현황 집계 (90일)
const computeFDP = (flights) => {
  const d90 = daysAgo(90);
  const in90 = flights.filter(f => f.date >= d90);
  const withRamp = in90.filter(f => f.rampOutUtc && f.rampInUtc);
  const fdpViolations = withRamp.filter(f => {
    const r = calcRamp(f);
    return r && r.fdpExceeds;
  });
  const maxFdp = withRamp.reduce((mx, f) => {
    const r = calcRamp(f);
    return r ? Math.max(mx, r.rampHrs) : mx;
  }, 0);
  // 가장 많이 사용된 승무 형태
  const crewCounts = {2:0, 3:0, 4:0};
  withRamp.forEach(f => { const c = parseInt(f.crew)||4; crewCounts[c] = (crewCounts[c]||0)+1; });
  const dominantCrew = Object.entries(crewCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 4;
  return { withRamp: withRamp.length, fdpViolations: fdpViolations.length, maxFdp, dominantCrew: parseInt(dominantCrew) };
};

const fmtWon  = (n) => Math.round(n||0).toLocaleString("ko-KR") + "원";
const fmtHrs  = (h) => { const hh=Math.floor(h||0),mm=Math.round(((h||0)-hh)*60); return `${hh}:${String(mm).padStart(2,"0")}`; };

// ─── Regulatory Computation ───────────────────────────────────────────────────
const computeCompliance = (flights) => {
  const now=today(), d28=daysAgo(28), d90=daysAgo(90), d365=daysAgo(365);
  const inRange=(f,from)=>f.date>=from&&f.date<=now;

  const hrs28  = flights.filter(f=>inRange(f,d28)).reduce((a,f)=>a+(f.total||0),0);
  const hrs90  = flights.filter(f=>inRange(f,d90)).reduce((a,f)=>a+(f.total||0),0);
  const hrs365 = flights.filter(f=>inRange(f,d365)).reduce((a,f)=>a+(f.total||0),0);

  const in90 = flights.filter(f=>inRange(f,d90));
  const to90      = in90.reduce((a,f)=>a+(f.to||0),0);
  const ldDay90   = in90.reduce((a,f)=>a+(f.ldDay||0),0);
  const ldNight90 = in90.reduce((a,f)=>a+(f.ldNight||0),0);
  const ldTotal90 = ldDay90+ldNight90;

  // Build sorted event arrays to find currency expiry
  const toEvts      = in90.flatMap(f=>Array(f.to||0).fill(f.date)).sort((a,b)=>b.localeCompare(a));
  const ldEvts      = in90.flatMap(f=>Array((f.ldDay||0)+(f.ldNight||0)).fill(f.date)).sort((a,b)=>b.localeCompare(a));
  const ldDayEvts   = in90.flatMap(f=>Array(f.ldDay||0).fill(f.date)).sort((a,b)=>b.localeCompare(a));
  const ldNightEvts = in90.flatMap(f=>Array(f.ldNight||0).fill(f.date)).sort((a,b)=>b.localeCompare(a));

  const currencyExpiry = (events, req=3) => {
    if(events.length<req) return null;
    const anchor=new Date(events[req-1]);
    anchor.setDate(anchor.getDate()+90);
    return anchor.toISOString().slice(0,10);
  };
  const daysLeft=(exp)=>exp?Math.ceil((new Date(exp)-new Date())/86400000):null;

  const toExpiry      = currencyExpiry(toEvts,3);
  const ldExpiry      = currencyExpiry(ldEvts,3);
  const ldDayExpiry   = currencyExpiry(ldDayEvts,3);
  const ldNightExpiry = currencyExpiry(ldNightEvts,3);

  return {
    hrs28, hrs90, hrs365,
    pct28:Math.min(100,hrs28/120*100), pct90:Math.min(100,hrs90/300*100), pct365:Math.min(100,hrs365/1000*100),
    to90, ldDay90, ldNight90, ldTotal90,
    toExpiry, ldExpiry, ldDayExpiry, ldNightExpiry,
    toExp:daysLeft(toExpiry), ldExp:daysLeft(ldExpiry),
    ldDayExp:daysLeft(ldDayExpiry), ldNightExp:daysLeft(ldNightExpiry),
    toCurrent:to90>=3, ldCurrent:ldTotal90>=3,
    ldDayCurrent:ldDay90>=3, ldNightCurrent:ldNight90>=3,
  };
};

// ─── Theme ────────────────────────────────────────────────────────────────────
const useTheme = () => {
  const [dark,setDark]=useState(()=>window.matchMedia("(prefers-color-scheme:dark)").matches);
  useEffect(()=>{ const mq=window.matchMedia("(prefers-color-scheme:dark)"); const h=e=>setDark(e.matches); mq.addEventListener("change",h); return ()=>mq.removeEventListener("change",h); },[]);
  return dark;
};
const DARK={bg:"#0f1117",card:"#181c26",border:"#252d3d",divider:"#1c2230",text:"#e8edf5",muted:"#5a6a82",accent:"#3b9eff",blue:"#5bb0ff",green:"#30d158",red:"#ff453a",orange:"#ff9f0a",purple:"#bf5af2",teal:"#32ade6",yellow:"#ffd60a",headerBg:"#0f1117",tabBg:"rgba(15,17,23,0.94)",warn:"rgba(255,69,58,0.13)",warnBorder:"#ff453a",ok:"rgba(48,209,88,0.11)",okBorder:"#30d158",caution:"rgba(255,159,10,0.13)",cautionBorder:"#ff9f0a",dividerLine:"#1c2230"};
const LIGHT={bg:"#f2f4f8",card:"#ffffff",border:"#dde3ee",divider:"#eaeef5",text:"#1a2035",muted:"#8896aa",accent:"#1a6fd4",blue:"#2b7de9",green:"#1a9e44",red:"#d93025",orange:"#d97706",purple:"#7c3aed",teal:"#0e7490",yellow:"#b45309",headerBg:"#ffffff",tabBg:"rgba(255,255,255,0.94)",warn:"rgba(217,48,37,0.08)",warnBorder:"#d93025",ok:"rgba(26,158,68,0.08)",okBorder:"#1a9e44",caution:"rgba(217,119,6,0.1)",cautionBorder:"#d97706",dividerLine:"#eaeef5"};

// ─── Real Flight Data (DutyLog-2026-02-16) ───────────────────────────────────
const makeSample = () => [
  {id:1000,date:"2026-02-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:5.57,sic:0,total:5.57,night:3.0,ifr:11.13,xc:5.57,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1001,date:"2026-02-11",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:4.5,sic:0,total:4.5,night:4.5,ifr:5.18,xc:4.5,ldDay:0,ldNight:0,to:0,flightNum:"KE602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1002,date:"2026-02-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.97,sic:0,total:5.97,night:4.5,ifr:5.97,xc:5.97,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1003,date:"2026-01-29",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8704",acType:"B787-9",pic:7.25,sic:0,total:7.25,night:2.0,ifr:7.25,xc:7.25,ldDay:1,ldNight:0,to:1,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1004,date:"2026-01-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:4.97,sic:0,total:4.97,night:0,ifr:4.97,xc:4.97,ldDay:0,ldNight:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1005,date:"2026-01-17",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.17,sic:0,total:6.17,night:0,ifr:6.17,xc:6.17,ldDay:1,ldNight:0,to:1,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1006,date:"2026-01-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.47,sic:0,total:5.47,night:3.83,ifr:5.47,xc:5.47,ldDay:0,ldNight:1,to:1,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1007,date:"2026-01-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.73,sic:0,total:4.73,night:4.33,ifr:4.73,xc:4.73,ldDay:0,ldNight:1,to:1,flightNum:"KE621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1008,date:"2025-12-25",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.25,sic:0,total:4.25,night:3.17,ifr:4.25,xc:4.25,ldDay:1,ldNight:0,to:1,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1009,date:"2025-12-16",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.07,sic:0,total:4.07,night:3.58,ifr:4.07,xc:4.07,ldDay:0,ldNight:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1010,date:"2025-12-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.07,sic:0,total:5.07,night:4.5,ifr:5.07,xc:5.07,ldDay:0,ldNight:0,to:0,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1011,date:"2025-12-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:5.25,sic:0,total:5.25,night:0,ifr:5.25,xc:5.25,ldDay:0,ldNight:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1012,date:"2025-12-03",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.25,sic:0,total:5.25,night:0,ifr:5.25,xc:5.25,ldDay:0,ldNight:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1013,date:"2025-12-08",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.83,sic:0,total:2.83,night:0,ifr:2.83,xc:2.83,ldDay:0,ldNight:0,to:0,flightNum:"KE732",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1014,date:"2025-12-05",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8703",acType:"B787-9",pic:2.3,sic:0,total:2.3,night:1.8,ifr:2.3,xc:2.3,ldDay:0,ldNight:0,to:0,flightNum:"KE731",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1015,date:"2025-12-04",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.58,sic:0,total:5.58,night:0,ifr:13.1,xc:5.58,ldDay:0,ldNight:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1016,date:"2025-11-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:11.23,sic:0,total:11.23,night:0,ifr:11.23,xc:11.23,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1017,date:"2025-11-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.68,sic:0,total:2.68,night:2.18,ifr:2.68,xc:2.68,ldDay:0,ldNight:1,to:1,flightNum:"KE732",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1018,date:"2025-11-20",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.02,sic:0,total:2.02,night:1.67,ifr:2.02,xc:2.02,ldDay:0,ldNight:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1019,date:"2025-11-13",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:6.75,sic:0,total:6.75,night:0,ifr:13.5,xc:6.75,ldDay:0,ldNight:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1020,date:"2025-10-24",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8703",acType:"B787-9",pic:5.5,sic:0,total:5.5,night:5.22,ifr:5.5,xc:5.5,ldDay:0,ldNight:1,to:1,flightNum:"KE151",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1021,date:"2025-10-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.57,sic:0,total:6.57,night:0,ifr:6.57,xc:6.57,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1022,date:"2025-10-07",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:6.48,sic:0,total:6.48,night:3.03,ifr:6.48,xc:6.48,ldDay:0,ldNight:0,to:0,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1023,date:"2025-10-06",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.65,sic:0,total:5.65,night:0,ifr:5.65,xc:5.65,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1024,date:"2025-10-01",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.55,sic:0,total:6.55,night:0,ifr:13.1,xc:6.55,ldDay:0,ldNight:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1025,date:"2025-09-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.07,sic:0,total:5.07,night:2.5,ifr:5.07,xc:5.07,ldDay:0,ldNight:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1026,date:"2025-09-16",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.5,sic:0,total:4.5,night:0,ifr:4.5,xc:4.5,ldDay:1,ldNight:0,to:1,flightNum:"KE5202",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1027,date:"2025-09-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.78,sic:0,total:5.78,night:0,ifr:11.57,xc:5.78,ldDay:1,ldNight:0,to:1,flightNum:"KE5201",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1028,date:"2025-09-04",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.27,sic:0,total:6.27,night:4.93,ifr:6.27,xc:6.27,ldDay:0,ldNight:0,to:0,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1029,date:"2025-08-29",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:5.83,sic:0,total:5.83,night:0,ifr:5.83,xc:5.83,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1030,date:"2025-08-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.28,sic:0,total:6.28,night:0,ifr:12.57,xc:6.28,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1031,date:"2025-08-26",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:1.92,sic:0,total:1.92,night:11.92,ifr:1.92,xc:1.92,ldDay:0,ldNight:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1032,date:"2025-08-17",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:7.78,sic:0,total:7.78,night:0.78,ifr:7.78,xc:7.78,ldDay:0,ldNight:0,to:0,flightNum:"KE131",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1033,date:"2025-08-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:3.82,sic:0,total:3.82,night:0,ifr:3.82,xc:3.82,ldDay:0,ldNight:0,to:0,flightNum:"KE131",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1034,date:"2025-08-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:6.15,sic:0,total:6.15,night:0,ifr:12.3,xc:6.15,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1035,date:"2025-08-08",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:6.37,sic:0,total:6.37,night:0,ifr:12.75,xc:6.37,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1036,date:"2025-07-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:5.52,sic:0,total:5.52,night:0.5,ifr:5.52,xc:5.52,ldDay:0,ldNight:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1037,date:"2025-07-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.02,sic:0,total:6.02,night:0,ifr:12.03,xc:6.02,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1038,date:"2025-07-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.32,sic:0,total:4.32,night:3.87,ifr:4.32,xc:4.32,ldDay:0,ldNight:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1039,date:"2025-07-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.45,sic:0,total:4.45,night:4.03,ifr:4.45,xc:4.45,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1040,date:"2025-06-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:1.3,sic:0,total:1.3,night:1.3,ifr:1.3,xc:1.3,ldDay:0,ldNight:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1041,date:"2025-06-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:2.28,sic:0,total:2.28,night:1.83,ifr:2.28,xc:2.28,ldDay:0,ldNight:0,to:0,flightNum:"KE731",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1042,date:"2025-06-20",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:5.63,sic:0,total:5.63,night:2.25,ifr:11.28,xc:5.63,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1043,date:"2025-06-13",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.67,sic:0,total:6.67,night:0,ifr:6.67,xc:6.67,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1044,date:"2025-06-01",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.15,sic:0,total:6.15,night:0,ifr:12.3,xc:6.15,ldDay:0,ldNight:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1045,date:"2025-06-03",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:5.3,sic:0,total:5.3,night:2.58,ifr:5.3,xc:5.3,ldDay:0,ldNight:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1046,date:"2025-05-11",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:3.98,sic:0,total:3.98,night:4.65,ifr:3.98,xc:3.98,ldDay:0,ldNight:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1047,date:"2025-05-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.42,sic:0,total:6.42,night:0,ifr:12.85,xc:6.42,ldDay:0,ldNight:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1048,date:"2025-04-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:5.63,sic:0,total:5.63,night:0,ifr:11.28,xc:5.63,ldDay:0,ldNight:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
];

// ─── Shared UI primitives ─────────────────────────────────────────────────────
const iStyle = (T) => ({width:"100%",background:T.card,border:`1px solid ${T.border}`,borderRadius:10,color:T.text,padding:"10px 12px",fontSize:13,outline:"none",fontFamily:"system-ui",marginBottom:2,display:"block"});
const Label = ({T,children}) => <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:4,marginTop:10}}>{children}</div>;

// ─── Hour Limit Bar ────────────────────────────────────────────────────────────
function HourLimitRow({T,label,sub,hrs,limit}) {
  const pct=Math.min(100,hrs/limit*100);
  const remaining=Math.max(0,limit-hrs);
  const critical=pct>=90, warn=pct>=75&&!critical;
  const color=critical?T.red:warn?T.orange:T.accent;
  return (
    <div style={{background:critical?T.warn:warn?T.caution:T.card,border:`1px solid ${critical?T.warnBorder:warn?T.cautionBorder:T.border}`,borderRadius:14,padding:"15px 18px",marginBottom:11}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase"}}>{sub}</div>
          <div style={{fontSize:12,color:T.text,marginTop:2,fontWeight:500}}>{label}</div>
          <div style={{display:"flex",alignItems:"baseline",gap:6,marginTop:5}}>
            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:26,fontWeight:700,color,lineHeight:1}}>{fmtH(hrs)}</span>
            <span style={{fontSize:11,color:T.muted}}>/ {fmtH(limit)}</span>
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:700,color,lineHeight:1}}>{pct.toFixed(1)}<span style={{fontSize:13}}>%</span></div>
          <div style={{fontSize:10,color:T.muted,marginTop:4}}>잔여 {fmtH(remaining)}</div>
        </div>
      </div>
      {/* Progress track */}
      <div style={{height:8,background:T.divider,borderRadius:4,overflow:"hidden"}}>
        <div style={{
          height:"100%",borderRadius:4,
          background:critical?`linear-gradient(90deg,${T.orange},${T.red})`:warn?`linear-gradient(90deg,${T.accent},${T.orange})`:`linear-gradient(90deg,${T.accent},${T.blue})`,
          width:`${pct}%`,transition:"width 0.9s cubic-bezier(.4,0,.2,1)",
        }}/>
      </div>
      {critical&&<div style={{marginTop:8,fontSize:11,fontWeight:700,color:T.red}}>⚠ 한도의 90% 초과 — 즉시 확인 필요</div>}
      {warn&&!critical&&<div style={{marginTop:8,fontSize:11,fontWeight:600,color:T.orange}}>△ 한도의 75% 초과 — 주의 요망</div>}
    </div>
  );
}

// ─── Currency Badge ────────────────────────────────────────────────────────────
function CurrencyBadge({T,label,icon,count,required,expiry,daysLeft}) {
  const ok=count>=required;
  const urgent=ok&&daysLeft!==null&&daysLeft<=15;
  const near  =ok&&daysLeft!==null&&daysLeft<=30&&!urgent;
  const color =!ok?T.red:urgent?T.orange:near?T.yellow:T.green;
  const bg    =!ok?T.warn:urgent?T.caution:near?"rgba(255,214,10,0.09)":T.ok;
  const bd    =!ok?T.warnBorder:urgent?T.cautionBorder:near?"#ffd60a":T.okBorder;
  return (
    <div style={{background:bg,border:`1px solid ${bd}`,borderRadius:14,padding:"14px 16px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:4}}>{label}</div>
          <div style={{display:"flex",alignItems:"baseline",gap:5}}>
            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:32,fontWeight:700,color,lineHeight:1}}>{count}</span>
            <span style={{fontSize:12,color:T.muted,fontWeight:500}}>/ {required}회</span>
          </div>
        </div>
        <div style={{width:40,height:40,borderRadius:"50%",background:ok?"rgba(48,209,88,0.15)":"rgba(255,69,58,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
          {ok?"✓":"✗"}
        </div>
      </div>
      {/* Status line */}
      {ok && daysLeft!==null && (
        <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${bd}50`,fontSize:10,color:urgent?T.orange:near?T.yellow:T.muted}}>
          <span>만료일 </span><span style={{fontFamily:"'IBM Plex Mono',monospace",fontWeight:600}}>{expiry}</span>
          <span style={{fontWeight:700,color,marginLeft:6}}>D-{daysLeft}</span>
        </div>
      )}
      {ok && daysLeft===null && (
        <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${bd}50`,fontSize:10,color:T.muted}}>만료 계산 중...</div>
      )}
      {!ok && (
        <div style={{marginTop:10,paddingTop:8,borderTop:`1px solid ${bd}50`,fontSize:11,fontWeight:700,color:T.red}}>
          ✗ {required-count}회 추가 필요 · 운항자격 미충족
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const isDark=useTheme(), T=isDark?DARK:LIGHT;
  const [flights,setFlights]=useStore("acl_v4_flights",makeSample());
  const [profile,setProfile]=useStore("acl_v4_profile",{name:"위종석",empNo:"P203001",license:"ATPL-A",medical:"",airline:"대한항공",base:"RKSI",acTypes:"B787-9",hourlyRate:""});
  const [tab,setTab]=useState(0);
  const [toast,setToast]=useState(null);
  const [modal,setModal]=useState(null);
  const [profileOpen,setProfileOpen]=useState(false);

  const notify=(msg,err=false)=>{setToast({msg,err});setTimeout(()=>setToast(null),2800);};

  const C=computeCompliance(flights);
  const FDP=computeFDP(flights);
  const totals=flights.reduce((a,f)=>({flights:a.flights+1,total:a.total+(f.total||0),pic:a.pic+(f.pic||0),sic:a.sic+(f.sic||0),night:a.night+(f.night||0),ifr:a.ifr+(f.ifr||0),xc:a.xc+(f.xc||0),ldDay:a.ldDay+(f.ldDay||0),ldNight:a.ldNight+(f.ldNight||0),to:a.to+(f.to||0)}),{flights:0,total:0,pic:0,sic:0,night:0,ifr:0,xc:0,ldDay:0,ldNight:0,to:0});

  const saveFlight=(f)=>{
    if(f.id){setFlights(p=>p.map(x=>x.id===f.id?f:x));notify("수정되었습니다");}
    else{setFlights(p=>[{...f,id:Date.now()},...p].sort((a,b)=>b.date.localeCompare(a.date)));notify("저장되었습니다");}
    setModal(null);
  };
  const deleteFlight=(id)=>{setFlights(p=>p.filter(f=>f.id!==id));setModal(null);notify("삭제되었습니다",true);};

  const exportCSV=()=>{
    const hdr=["날짜","출발","도착","출발시간","도착시간","기체","기종","총시간","기장","부기장","야간","계기","XC","주간착륙","야간착륙","이륙","비고"];
    const rows=flights.map(f=>[f.date,f.dep,f.arr,f.depTime||"",f.arrTime||"",f.aircraft||"",f.acType||"",fmt1(f.total),fmt1(f.pic),fmt1(f.sic),fmt1(f.night),fmt1(f.ifr),fmt1(f.xc),f.ldDay||0,f.ldNight||0,f.to||0,`"${(f.remarks||"").replace(/"/g,'""')}"`]);
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\uFEFF"+[hdr,...rows].map(r=>r.join(",")).join("\n")],{type:"text/csv;charset=utf-8"}));a.download=`logbook_${today()}.csv`;a.click();notify("CSV 내보내기 완료");
  };

  const exportPDF=()=>{
    const rows=flights.map(f=>`<tr><td>${f.date}</td><td>${f.dep}</td><td>${f.arr}</td><td>${f.aircraft||""}</td><td>${f.acType||""}</td><td>${fmtH(f.total)}</td><td>${fmtH(f.pic)}</td><td>${fmtH(f.night)}</td><td>${(f.ldDay||0)+(f.ldNight||0)}</td><td>${f.to||0}</td><td>${f.remarks||""}</td></tr>`).join("");
    const w=window.open("","_blank");
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logbook – ${profile.name}</title><style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:'Courier New',mono;font-size:8.5pt;padding:22px;color:#111}
    h1{font-size:15pt;margin-bottom:3px}.sub{font-size:8pt;color:#555;margin-bottom:16px}
    h2{font-size:10pt;background:#1a2744;color:#fff;padding:5px 10px;margin:14px 0 8px;border-radius:3px}
    .limits{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px}
    .lc{border:1px solid #ccc;border-radius:4px;padding:10px;text-align:center}
    .lc .val{font-size:16pt;font-weight:700}.lc .lbl{font-size:7pt;color:#555;margin-bottom:4px}
    .lc .bar{height:5px;background:#ddd;border-radius:3px;margin-top:5px}
    .lc .fill{height:5px;border-radius:3px}
    .currency{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px}
    .cc{border:1px solid #ccc;border-radius:4px;padding:8px;text-align:center}
    .cc .num{font-size:20pt;font-weight:700}.cc .lab{font-size:7pt;color:#555}
    .ok{color:#1a7a3c}.warn{color:#c44}.caution{color:#b87000}
    table{width:100%;border-collapse:collapse;font-size:7.5pt;margin-top:6px}
    th{background:#1a2744;color:#fff;padding:4px 3px;text-align:center;border:1px solid #aaa}
    td{padding:3px;border:1px solid #ddd;text-align:center}tr:nth-child(even){background:#f5f7fb}
    @media print{.pbtn{display:none!important}}
    .pbtn{margin:0 0 12px;padding:9px 22px;background:#1a2744;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10pt}
    </style></head><body>
    <button class="pbtn" onclick="window.print()">🖨 인쇄 / PDF 저장</button>
    <h1>✈ 조종사 전자 로그북</h1>
    <div class="sub">${profile.name} | ${profile.empNo} | ${profile.license} | ${profile.airline} | 출력: ${today()}</div>
    <h2>📋 규정 준수 현황</h2>
    <div class="limits">
      <div class="lc"><div class="lbl">28일 비행시간 / 한도 120:00</div><div class="val ${C.hrs28/120>=0.9?"warn":"ok"}">${fmtH(C.hrs28)}</div><div class="bar"><div class="fill" style="width:${Math.min(100,C.hrs28/120*100)}%;background:${C.hrs28/120>=0.9?"#c44":"#1a6fd4"}"></div></div></div>
      <div class="lc"><div class="lbl">90일 비행시간 / 한도 300:00</div><div class="val ${C.hrs90/300>=0.9?"warn":"ok"}">${fmtH(C.hrs90)}</div><div class="bar"><div class="fill" style="width:${Math.min(100,C.hrs90/300*100)}%;background:${C.hrs90/300>=0.9?"#c44":"#1a6fd4"}"></div></div></div>
      <div class="lc"><div class="lbl">365일 비행시간 / 한도 1000:00</div><div class="val ${C.hrs365/1000>=0.9?"warn":"ok"}">${fmtH(C.hrs365)}</div><div class="bar"><div class="fill" style="width:${Math.min(100,C.hrs365/1000*100)}%;background:${C.hrs365/1000>=0.9?"#c44":"#1a6fd4"}"></div></div></div>
    </div>
    <div class="currency">
      <div class="cc"><div class="lab">90일 이륙 (≥3회)</div><div class="num ${C.toCurrent?"ok":"warn"}">${C.to90}</div><div class="lab">${C.toCurrent?"✓ 충족":C.toExpiry?"만료 "+C.toExpiry:"✗ 미충족"}</div></div>
      <div class="cc"><div class="lab">90일 착륙 합계 (≥3)</div><div class="num ${C.ldCurrent?"ok":"warn"}">${C.ldTotal90}</div><div class="lab">${C.ldCurrent?"✓ 충족":C.ldExpiry?"만료 "+C.ldExpiry:"✗ 미충족"}</div></div>
      <div class="cc"><div class="lab">90일 주간착륙 (≥3)</div><div class="num ${C.ldDayCurrent?"ok":"warn"}">${C.ldDay90}</div><div class="lab">${C.ldDayCurrent?"✓ 충족":C.ldDayExpiry?"만료 "+C.ldDayExpiry:"✗ 미충족"}</div></div>
      <div class="cc"><div class="lab">90일 야간착륙 (≥3)</div><div class="num ${C.ldNightCurrent?"ok":"warn"}">${C.ldNight90}</div><div class="lab">${C.ldNightCurrent?"✓ 충족":C.ldNightExpiry?"만료 "+C.ldNightExpiry:"✗ 미충족"}</div></div>
    </div>
    <h2>비행 기록 (${flights.length}편 · 총 ${fmtH(totals.total)})</h2>
    <table><tr><th>날짜</th><th>출발</th><th>도착</th><th>기체</th><th>기종</th><th>총시간</th><th>기장</th><th>야간</th><th>착륙</th><th>이륙</th><th>비고</th></tr>${rows}</table>
    </body></html>`);w.document.close();notify("PDF 창이 열렸습니다");
  };

  const alertCount=[!C.toCurrent,!C.ldCurrent,C.pct28>=90,C.pct90>=90,C.pct365>=90,C.toExp!==null&&C.toExp<=30,C.ldExp!==null&&C.ldExp<=30,C.ldDayExp!==null&&C.ldDayExp<=30,C.ldNightExp!==null&&C.ldNightExp<=30].filter(Boolean).length;

  const TABS=[{icon:"🏠",label:"홈"},{icon:"🛡",label:"규정",badge:alertCount},{icon:"✚",label:"입력"},{icon:"📋",label:"기록"},{icon:"💰",label:"수당"}];

  return (
    <div style={{minHeight:"100dvh",maxWidth:430,margin:"0 auto",background:T.bg,color:T.text,fontFamily:"'SF Pro Display','Helvetica Neue',system-ui,sans-serif",position:"relative"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=Bebas+Neue&display=swap');
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        input,select,textarea{-webkit-appearance:none;appearance:none}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:${T.border};border-radius:2px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .fu{animation:fadeUp 0.32s ease both}.pressable{transition:transform .12s,opacity .12s}.pressable:active{transform:scale(0.97);opacity:.8}
        .rt:active{opacity:.55}.pulse{animation:pulse 2s infinite}
      `}</style>

      {/* Header */}
      <div style={{padding:"50px 20px 14px",background:T.headerBg,borderBottom:`1px solid ${T.border}`,position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
          {/* Tappable profile area */}
          <button onClick={()=>setProfileOpen(true)} className="pressable"
            style={{background:"none",border:"none",padding:0,textAlign:"left",cursor:"pointer"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:9,letterSpacing:5,color:T.muted}}>AIRLINE PILOT</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,letterSpacing:2,color:T.accent,lineHeight:1.1}}>CAPTAIN'S LOGBOOK</div>
            <div style={{display:"flex",alignItems:"center",gap:5,marginTop:2}}>
              <span style={{fontSize:10,color:T.muted}}>{profile.name} · {profile.airline}</span>
              <span style={{fontSize:9,color:T.accent,background:`${T.accent}18`,borderRadius:4,padding:"1px 5px",letterSpacing:0.5}}>✎ 편집</span>
            </div>
          </button>
          <div style={{textAlign:"right"}}>
            {alertCount>0&&<div className="pulse" style={{fontSize:10,color:T.red,fontWeight:700,marginBottom:3}}>⚠ {alertCount}건 경고</div>}
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:24,fontWeight:700,color:T.accent,lineHeight:1}}>{fmtH(totals.total)}</div>
            <div style={{fontSize:9,color:T.muted,letterSpacing:2}}>TOTAL HRS</div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{minHeight:"calc(100dvh - 165px)",overflowY:"auto",paddingBottom:90}}>
        {tab===0&&<HomeTab T={T} totals={totals} flights={flights} profile={profile} C={C} onGoto={()=>setTab(1)} onCSV={exportCSV} onPDF={exportPDF}/>}
        {tab===1&&<ComplianceTab T={T} C={C} fdp={FDP}/>}
        {tab===2&&<FlightForm T={T} onSave={saveFlight} notify={notify}/>}
        {tab===3&&<FlightList T={T} flights={flights} onDetail={f=>setModal({type:"detail",data:f})} totals={totals}/>}
        {tab===4&&<PayTab T={T} flights={flights} profile={profile} setProfile={setProfile} notify={notify}/>}
      </div>

      {/* Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:430,background:T.tabBg,borderTop:`1px solid ${T.border}`,display:"flex",zIndex:100,paddingBottom:"env(safe-area-inset-bottom,10px)",backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)"}}>
        {TABS.map((t,i)=>(
          <button key={i} onClick={()=>setTab(i)} className="pressable" style={{flex:1,padding:"10px 0 8px",border:"none",background:"none",cursor:"pointer",borderTop:tab===i?`2px solid ${T.accent}`:"2px solid transparent",color:tab===i?T.accent:T.muted,position:"relative"}}>
            <div style={{fontSize:i===2?22:16,lineHeight:1}}>{t.icon}</div>
            <div style={{fontSize:9,marginTop:2,letterSpacing:0.3,fontWeight:tab===i?700:400}}>{t.label}</div>
            {t.badge>0&&<div style={{position:"absolute",top:6,right:"50%",transform:"translateX(10px)",background:T.red,color:"#fff",borderRadius:10,fontSize:9,fontWeight:700,padding:"1px 5px",minWidth:16,textAlign:"center"}}>{t.badge}</div>}
          </button>
        ))}
      </div>

      {toast&&<div style={{position:"fixed",bottom:90,left:"50%",transform:"translateX(-50%)",background:toast.err?T.red:T.accent,color:"#fff",padding:"10px 22px",borderRadius:20,fontSize:13,zIndex:999,animation:"toastIn 0.3s ease",whiteSpace:"nowrap",fontWeight:600,boxShadow:"0 4px 20px rgba(0,0,0,0.3)"}}>{toast.err?"🗑 ":"✓ "}{toast.msg}</div>}

      {modal?.type==="detail"&&<DetailModal T={T} flight={modal.data} onClose={()=>setModal(null)} onEdit={f=>setModal({type:"form",data:f})} onDelete={deleteFlight}/>}
      {modal?.type==="form"  &&<FormModal   T={T} initial={modal.data} onSave={saveFlight} onClose={()=>setModal(null)} notify={notify}/>}
      {profileOpen&&<ProfileModal T={T} profile={profile} setProfile={setProfile} onClose={()=>setProfileOpen(false)} notify={notify}/>}
    </div>
  );
}

// ─── Home Tab ─────────────────────────────────────────────────────────────────
function HomeTab({T,totals,flights,profile,C,onGoto,onCSV,onPDF}) {
  const medDays=Math.ceil((new Date(profile.medical)-new Date())/86400000);
  const last30=flights.filter(f=>(new Date()-new Date(f.date))/86400000<=30).reduce((a,f)=>a+(f.total||0),0);
  const overallOk=C.toCurrent&&C.ldCurrent&&C.pct28<90&&C.pct90<90&&C.pct365<90;
  return (
    <div style={{padding:"18px 16px"}} className="fu">
      {/* Compliance Banner */}
      <button onClick={onGoto} className="pressable" style={{width:"100%",background:overallOk?T.ok:T.warn,border:`1px solid ${overallOk?T.okBorder:T.warnBorder}`,borderRadius:16,padding:"16px 18px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",textAlign:"left"}}>
        <div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase"}}>규정 준수 현황</div>
          <div style={{fontSize:16,fontWeight:700,color:overallOk?T.green:T.red,marginTop:4}}>{overallOk?"✓ 모든 규정 충족":"⚠ 위반 / 경고 발생"}</div>
          <div style={{fontSize:10,color:T.muted,marginTop:3}}>탭하여 상세 확인 →</div>
        </div>
        <div style={{width:50,height:50,borderRadius:"50%",flexShrink:0,background:overallOk?"rgba(48,209,88,0.18)":"rgba(255,69,58,0.18)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:26}}>{overallOk?"🟢":"🔴"}</div>
      </button>

      {/* 90-day currency quick view */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"15px 18px",marginBottom:14}}>
        <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:12}}>90일 이착륙 통화</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,textAlign:"center"}}>
          {[{l:"이륙",v:C.to90,ok:C.toCurrent},{l:"총착륙",v:C.ldTotal90,ok:C.ldCurrent},{l:"주간",v:C.ldDay90,ok:C.ldDayCurrent},{l:"야간",v:C.ldNight90,ok:C.ldNightCurrent}].map((s,i)=>(
            <div key={i} style={{background:s.ok?T.ok:T.warn,border:`1px solid ${s.ok?T.okBorder:T.warnBorder}`,borderRadius:10,padding:"10px 6px"}}>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:700,color:s.ok?T.green:T.red,lineHeight:1}}>{s.v}</div>
              <div style={{fontSize:8,color:T.muted,marginTop:3}}>{s.l}</div>
              <div style={{fontSize:13,marginTop:2}}>{s.ok?"✓":"✗"}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Medical */}
      <div style={{background:medDays<60?T.warn:T.card,border:`1px solid ${medDays<60?T.warnBorder:T.border}`,borderRadius:16,padding:"14px 18px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase"}}>Medical Certificate</div>
          <div style={{fontSize:14,fontWeight:600,color:T.text,marginTop:3}}>{profile.medical}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:30,fontWeight:700,color:medDays<60?T.red:T.green,lineHeight:1}}>{medDays}</div>
          <div style={{fontSize:9,color:T.muted}}>DAYS LEFT</div>
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
        {[{s:"Total",v:fmtH(totals.total),c:T.accent},{s:"PIC",v:fmtH(totals.pic),c:T.blue},{s:"Night",v:fmtH(totals.night),c:T.purple},{s:"IFR",v:fmtH(totals.ifr),c:T.teal},{s:"30일",v:fmtH(last30),c:T.orange},{s:"편수",v:totals.flights+"편",c:T.green}].map((s,i)=>(
          <div key={i} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"13px 15px"}}>
            <div style={{fontSize:8,color:T.muted,letterSpacing:2,textTransform:"uppercase"}}>{s.s}</div>
            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:700,color:s.c,marginTop:4,lineHeight:1}}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <button onClick={onCSV} className="pressable" style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,color:T.green,padding:"13px",fontSize:13,fontWeight:600,cursor:"pointer"}}>📥 CSV 내보내기</button>
        <button onClick={onPDF} className="pressable" style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,color:T.blue,padding:"13px",fontSize:13,fontWeight:600,cursor:"pointer"}}>🖨 PDF 출력</button>
      </div>
    </div>
  );
}

// ─── Compliance Tab ────────────────────────────────────────────────────────────
function ComplianceTab({T,C,fdp}) {
  const SectionLabel=({children,right})=>(
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:13,marginTop:20}}>
      <span style={{fontSize:10,color:T.muted,letterSpacing:3,textTransform:"uppercase",fontWeight:700,whiteSpace:"nowrap"}}>{children}</span>
      <div style={{flex:1,height:1,background:T.border}}/>
      {right&&<span style={{fontSize:9,color:T.muted,whiteSpace:"nowrap"}}>{right}</span>}
    </div>
  );
  return (
    <div style={{padding:"18px 16px"}} className="fu">

      {/* FDP 현황 */}
      <SectionLabel right="ICAO Annex 6">⏱ 비행근무시간 (FDP) — UTC 기준</SectionLabel>
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"15px 18px",marginBottom:11}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:12}}>
          {[
            {l:"Ramp 기록 보유",v:fdp.withRamp+"편",c:T.accent},
            {l:"최대 FDP",v:fmtHrs(fdp.maxFdp),c:fdp.maxFdp>13?T.red:T.green},
            {l:"FDP 초과 편수",v:fdp.fdpViolations+"편",c:fdp.fdpViolations>0?T.red:T.green},
          ].map(s=>(
            <div key={s.l} style={{textAlign:"center",background:T.bg,borderRadius:10,padding:"10px 6px"}}>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:700,color:s.c,lineHeight:1}}>{s.v}</div>
              <div style={{fontSize:8,color:T.muted,marginTop:4,lineHeight:1.3}}>{s.l}</div>
            </div>
          ))}
        </div>
        <div style={{height:6,background:T.divider,borderRadius:3,overflow:"hidden"}}>
          <div style={{height:"100%",borderRadius:3,background:fdp.maxFdp>13?`linear-gradient(90deg,${T.orange},${T.red})`:`linear-gradient(90deg,${T.accent},${T.green})`,width:`${Math.min(100,fdp.maxFdp/13*100)}%`,transition:"width 0.8s"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.muted,marginTop:4}}>
          <span>0:00</span>
          <span style={{color:fdp.maxFdp>13?T.red:T.muted,fontWeight:fdp.maxFdp>13?700:400}}>한도 13:00</span>
          <span>최대 {fmtHrs(fdp.maxFdp)}</span>
        </div>
        <div style={{marginTop:10,padding:"8px 10px",background:`${T.accent}10`,borderRadius:8,fontSize:10,color:T.muted,lineHeight:1.6}}>
          💡 <strong style={{color:T.text}}>FDP(Flight Duty Period)</strong>는 Ramp Out(UTC)부터 Ramp In(UTC)까지의 전체 근무시간입니다.
        </div>
        {/* 승무 형태별 한도 표 */}
        <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
          {[[2,"기본","13:00"],[3,"강화(RP)","15:00"],[4,"완전강화","18:00"]].map(([c,lbl,limit])=>(
            <div key={c} style={{
              background: fdp.dominantCrew===c ? `${T.accent}18` : T.bg,
              border:`1px solid ${fdp.dominantCrew===c ? T.accent : T.border}`,
              borderRadius:10, padding:"9px 6px", textAlign:"center",
            }}>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:700,color:fdp.dominantCrew===c?T.accent:T.text}}>{limit}</div>
              <div style={{fontSize:8,color:T.muted,marginTop:3}}>{c}인 승무</div>
              <div style={{fontSize:8,color:T.muted}}>{lbl}</div>
              {fdp.dominantCrew===c&&<div style={{fontSize:8,color:T.accent,fontWeight:700,marginTop:2}}>주 사용</div>}
            </div>
          ))}
        </div>
      </div>

      <SectionLabel right="KCAB / ICAO Annex 6">⏱ 비행시간 한도</SectionLabel>
      <HourLimitRow T={T} sub="28-DAY LIMIT" label="28일 비행시간 한도" hrs={C.hrs28} limit={120}/>
      <HourLimitRow T={T} sub="90-DAY LIMIT" label="90일 비행시간 한도" hrs={C.hrs90} limit={300}/>
      <HourLimitRow T={T} sub="365-DAY LIMIT" label="365일 비행시간 한도" hrs={C.hrs365} limit={1000}/>

      <SectionLabel right="항공안전법 제53조">🛬 90일 이착륙 통화 (각 3회)</SectionLabel>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
        <CurrencyBadge T={T} label="이륙 (T/O)" count={C.to90} required={3} expiry={C.toExpiry} daysLeft={C.toExp}/>
        <CurrencyBadge T={T} label="착륙 합계" count={C.ldTotal90} required={3} expiry={C.ldExpiry} daysLeft={C.ldExp}/>
        <CurrencyBadge T={T} label="주간 착륙" count={C.ldDay90} required={3} expiry={C.ldDayExpiry} daysLeft={C.ldDayExp}/>
        <CurrencyBadge T={T} label="야간 착륙" count={C.ldNight90} required={3} expiry={C.ldNightExpiry} daysLeft={C.ldNightExp}/>
      </div>

      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginTop:6}}>
        <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>법규 근거</div>
        {[
          ["FDP 2인 ≤13:00","ICAO Annex 6 / 항공안전법 시행규칙 별표 12"],
          ["FDP 3인 ≤15:00","ICAO Annex 6 (강화 승무·RP 포함)"],
          ["FDP 4인 ≤18:00","ICAO Annex 6 (완전 강화 승무)"],
          ["28일 120:00 한도","항공안전법 시행규칙 별표 11"],
          ["90일 300:00 한도","항공안전법 시행규칙 별표 11"],
          ["365일 1,000:00 한도","항공안전법 시행규칙 별표 11 / ICAO Annex 6"],
          ["이착륙 각 3회 / 90일","항공안전법 제53조 (운항자격 유지)"],
          ["Ramp 시간 기준","UTC 기준 기록 (비행근무시간 국제 표준)"],
          ["야간수당 기준","KST 22:00~06:00 (UTC 13:00~21:00)"],
        ].map(([rule,basis])=>(
          <div key={rule} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"8px 0",borderBottom:`1px solid ${T.dividerLine}`}}>
            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:600,color:T.text,minWidth:120}}>{rule}</span>
            <span style={{fontSize:10,color:T.muted,textAlign:"right",maxWidth:"55%",lineHeight:1.4}}>{basis}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


// ─── Flight Form ──────────────────────────────────────────────────────────────
function FlightForm({T,onSave,notify}) {
  const blank={date:today(),flightNum:"",dep:"",arr:"",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",crew:"4",aircraft:"",acType:"B787-9",pic:"",sic:"",night:"",ifr:"",xc:"",ldDay:1,ldNight:0,to:1,remarks:"",captain:"",fo:""};
  const [f,setF]=useState(blank);
  const [depQ,setDepQ]=useState(""), [arrQ,setArrQ]=useState(""), [computed,setComputed]=useState(0);
  const acTypes=["B737-700","B737-800","B737-900","B737-900ER","B777-200ER","B777-300ER","B787-8","B787-9","B787-10","A320","A320neo","A321","A321neo","A330-200","A330-300","A330-900neo","A350-900","A350-1000","A380-800","기타"];

  const upd=(k,v)=>setF(p=>{
    const n={...p,[k]:v};
    if(k==="depTime"||k==="arrTime"){
      const t=decHrs(n.depTime,n.arrTime);
      setComputed(t);
      if(t>0){if(!n.pic)n.pic=t.toFixed(2);if(!n.xc)n.xc=t.toFixed(2);if(!n.ifr)n.ifr=t.toFixed(2);}
    }
    return n;
  });

  // UTC Ramp 기반 실시간 계산
  const rampCalc = calcRamp(f);

  const ASearch=({val,q,setQ,onSel,label})=>{
    const res=Object.entries(ICAO_DB).filter(([k,v])=>q.length>=1&&(k.startsWith(q.toUpperCase())||v.includes(q))).slice(0,5);
    return (<div>
      <Label T={T}>{label}</Label>
      <input value={val||q} onChange={e=>{setQ(e.target.value);onSel("");}} placeholder="ICAO코드 또는 공항명" style={iStyle(T)}/>
      {res.length>0&&<div style={{background:T.card,border:`1px solid ${T.accent}`,borderRadius:8,marginTop:-1,overflow:"hidden",zIndex:20,position:"relative",boxShadow:"0 4px 16px rgba(0,0,0,0.2)"}}>
        {res.map(([k,v])=><div key={k} onClick={()=>{onSel(k);setQ("");}} className="rt" style={{padding:"9px 13px",cursor:"pointer",borderBottom:`1px solid ${T.dividerLine}`,display:"flex",gap:10,alignItems:"center"}}>
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontWeight:700,color:T.accent,fontSize:13,minWidth:40}}>{k}</span>
          <span style={{color:T.muted,fontSize:11}}>{v}</span>
        </div>)}
      </div>}
    </div>);
  };

  const save=()=>{
    if(!f.date||!f.dep||!f.arr){notify("날짜, 출발지, 목적지를 입력하세요",true);return;}
    const total=computed||parseFloat(f.pic)||0;
    onSave({...f,total,pic:parseFloat(f.pic)||0,sic:parseFloat(f.sic)||0,night:parseFloat(f.night)||0,ifr:parseFloat(f.ifr)||0,xc:parseFloat(f.xc)||total,ldDay:parseInt(f.ldDay)||0,ldNight:parseInt(f.ldNight)||0,to:parseInt(f.to)||0});
    setF(blank);setComputed(0);setDepQ("");setArrQ("");
  };

  return (
    <div style={{padding:"16px"}} className="fu">
      <div style={{fontSize:10,color:T.muted,letterSpacing:3,textTransform:"uppercase",marginBottom:14}}>— New Flight Entry —</div>

      <Label T={T}>날짜 (Ramp Out UTC 기준일)</Label>
      <input type="date" value={f.date} onChange={e=>upd("date",e.target.value)} style={iStyle(T)}/>

      {/* 편명 + 승무원 수 */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div>
          <Label T={T}>✈ 편명 (Flight No.)</Label>
          <input value={f.flightNum} onChange={e=>upd("flightNum",e.target.value.toUpperCase())}
            placeholder="KE101"
            style={{...iStyle(T),fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,letterSpacing:1}}/>
        </div>
        <div>
          <Label T={T}>👥 승무 형태 (FDP 기준)</Label>
          <select value={f.crew} onChange={e=>upd("crew",e.target.value)} style={{...iStyle(T),color:T.text,fontWeight:600}}>
            <option value="2">2인 승무 (FDP ≤13h)</option>
            <option value="3">3인 승무 (FDP ≤15h)</option>
            <option value="4">4인 승무 (FDP ≤18h)</option>
          </select>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <ASearch val={f.dep} q={depQ} setQ={setDepQ} onSel={v=>upd("dep",v)} label="출발 (ICAO)"/>
        <ASearch val={f.arr} q={arrQ} setQ={setArrQ} onSel={v=>upd("arr",v)} label="도착 (ICAO)"/>
      </div>

      {/* ── RAMP TIME — UTC 기준 (FDP 자격관리) ─────────────── */}
      <div style={{background:`${T.orange}10`,border:`2px solid ${T.orange}60`,borderRadius:14,padding:"14px 16px",marginTop:10,marginBottom:6}}>

        {/* 헤더 */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontSize:10,color:T.orange,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>🚧 RAMP TIME — UTC</div>
            <div style={{fontSize:9,color:T.muted,marginTop:2,lineHeight:1.5}}>
              비행근무시간(FDP) 기준<br/>
              <span style={{color:T.orange,fontWeight:600}}>UTC로 입력</span> · 야간수당은 KST 자동 환산
            </div>
          </div>
          {rampCalc&&(
            <div style={{background:rampCalc.fdpExceeds?T.warn:T.ok,border:`1px solid ${rampCalc.fdpExceeds?T.warnBorder:T.okBorder}`,borderRadius:10,padding:"8px 12px",textAlign:"center",flexShrink:0}}>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:700,color:rampCalc.fdpExceeds?T.red:T.green,lineHeight:1}}>{fmtHrs(rampCalc.rampHrs)}</div>
              <div style={{fontSize:8,color:T.muted,marginTop:3}}>한도 {fmtHrs(rampCalc.fdpLimit)} · {rampCalc.fdpExceeds?"⚠ 초과":"✓ 정상"}</div>
            </div>
          )}
        </div>

        {/* UTC 입력란 */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div>
            <div style={{fontSize:10,color:T.orange,fontWeight:700,letterSpacing:1,marginBottom:5}}>RAMP OUT <span style={{color:T.muted,fontWeight:400,fontSize:9}}>(UTC)</span></div>
            <input type="time" value={f.rampOutUtc} onChange={e=>upd("rampOutUtc",e.target.value)}
              style={{...iStyle(T),border:`2px solid ${T.orange}70`,fontFamily:"'IBM Plex Mono',monospace",fontSize:18,fontWeight:700,textAlign:"center",padding:"11px 8px",letterSpacing:1}}/>
          </div>
          <div>
            <div style={{fontSize:10,color:T.orange,fontWeight:700,letterSpacing:1,marginBottom:5}}>RAMP IN <span style={{color:T.muted,fontWeight:400,fontSize:9}}>(UTC)</span></div>
            <input type="time" value={f.rampInUtc} onChange={e=>upd("rampInUtc",e.target.value)}
              style={{...iStyle(T),border:`2px solid ${T.orange}70`,fontFamily:"'IBM Plex Mono',monospace",fontSize:18,fontWeight:700,textAlign:"center",padding:"11px 8px",letterSpacing:1}}/>
          </div>
        </div>

        {/* KST 자동 환산 표시 */}
        {rampCalc&&(
          <div style={{marginTop:10,padding:"9px 12px",background:T.card,borderRadius:10,border:`1px solid ${T.border}`,display:"grid",gridTemplateColumns:"1fr 16px 1fr",alignItems:"center",gap:4}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:8,color:T.muted,letterSpacing:1,marginBottom:2}}>RAMP OUT KST</div>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:17,fontWeight:700,color:T.teal}}>{rampCalc.roKstStr}</div>
            </div>
            <div style={{fontSize:12,color:T.muted,textAlign:"center"}}>→</div>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:8,color:T.muted,letterSpacing:1,marginBottom:2}}>RAMP IN KST</div>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:17,fontWeight:700,color:T.teal}}>{rampCalc.riKstStr}</div>
            </div>
          </div>
        )}

        {/* 계산 결과 3분할 */}
        {rampCalc&&(
          <div style={{marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,paddingTop:10,borderTop:`1px solid ${T.orange}30`}}>
            {[
              {l:"FDP (UTC기준)",   v:fmtHrs(rampCalc.rampHrs),    c:rampCalc.fdpExceeds?T.red:T.orange, warn:rampCalc.fdpExceeds},
              {l:"야간 (KST기준)", v:fmtHrs(rampCalc.nightHrs),   c:T.purple, warn:false},
              {l:"연장 (8H 초과)", v:fmtHrs(rampCalc.overtimeHrs),c:rampCalc.overtimeHrs>0?T.red:T.muted, warn:rampCalc.overtimeHrs>0},
            ].map(s=>(
              <div key={s.l} style={{textAlign:"center",background:s.warn?T.warn:T.bg,borderRadius:8,padding:"8px 4px",border:`1px solid ${s.warn?T.warnBorder:T.border}`}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:s.c,lineHeight:1}}>{s.v}</div>
                <div style={{fontSize:8,color:T.muted,marginTop:3,lineHeight:1.3}}>{s.l}</div>
              </div>
            ))}
          </div>
        )}

        {rampCalc?.fdpExceeds&&(
          <div style={{marginTop:8,padding:"8px 11px",background:T.warn,border:`1px solid ${T.warnBorder}`,borderRadius:8,fontSize:11,fontWeight:700,color:T.red}}>
            ⚠ FDP {fmtHrs(rampCalc.rampHrs)} — {FDP_LABEL[rampCalc.crew]} 한도 {fmtHrs(rampCalc.fdpLimit)} 초과
          </div>
        )}
      </div>

      {/* ── WHEELS TIMES — UTC ─────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div><Label T={T}>이륙 OFF (UTC)</Label><input type="time" value={f.depTime} onChange={e=>upd("depTime",e.target.value)} style={iStyle(T)}/></div>
        <div><Label T={T}>착륙 ON (UTC)</Label><input type="time" value={f.arrTime} onChange={e=>upd("arrTime",e.target.value)} style={iStyle(T)}/></div>
      </div>

      {computed>0&&<div style={{background:`${T.accent}16`,border:`1px solid ${T.accent}44`,borderRadius:10,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
        <span style={{fontSize:11,color:T.accent}}>⏱ 자동 계산 비행시간</span>
        <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,color:T.accent,fontWeight:700}}>{fmtH(computed)}</span>
      </div>}

      <Label T={T}>기체 등록번호</Label>
      <input value={f.aircraft} onChange={e=>upd("aircraft",e.target.value.toUpperCase())} placeholder="HL7732" style={iStyle(T)}/>
      <Label T={T}>기종</Label>
      <select value={f.acType} onChange={e=>upd("acType",e.target.value)} style={{...iStyle(T),color:T.text}}>
        {acTypes.map(t=><option key={t}>{t}</option>)}
      </select>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
        {[["pic","기장(PIC)"],["sic","부기장(SIC)"],["night","야간"],["ifr","계기(IFR)"],["xc","장거리(XC)"]].map(([k,l])=>(
          <div key={k}><Label T={T}>{l}</Label><input type="number" step="0.01" value={f[k]} onChange={e=>upd(k,e.target.value)} placeholder="0.0" style={iStyle(T)}/></div>
        ))}
      </div>

      <div style={{background:`${T.green}10`,border:`2px solid ${T.green}50`,borderRadius:14,padding:"14px 16px",marginTop:8,marginBottom:4}}>
        <div style={{fontSize:9,color:T.green,letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>🛬 이착륙 — 90일 통화 관리</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          {[["to","✈ 이륙"],["ldDay","☀ 주간착륙"],["ldNight","🌙 야간착륙"]].map(([k,l])=>(
            <div key={k}>
              <div style={{fontSize:10,color:T.green,fontWeight:600,marginBottom:5,textAlign:"center"}}>{l}</div>
              <input type="number" min="0" value={f[k]} onChange={e=>upd(k,e.target.value)}
                style={{...iStyle(T),textAlign:"center",fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:700,color:T.green,border:`1px solid ${T.green}60`,padding:"12px 8px"}}/>
            </div>
          ))}
        </div>
      </div>

      <Label T={T}>기장</Label><input value={f.captain} onChange={e=>upd("captain",e.target.value)} placeholder="기장 성명" style={iStyle(T)}/>
      <Label T={T}>부기장(F/O)</Label><input value={f.fo} onChange={e=>upd("fo",e.target.value)} placeholder="부기장 성명" style={iStyle(T)}/>
      <Label T={T}>비고 (Remarks)</Label>
      <textarea value={f.remarks} onChange={e=>upd("remarks",e.target.value)} rows={3} placeholder="비행 특이사항, 기상, 비고..." style={{...iStyle(T),resize:"vertical",lineHeight:1.7}}/>
      <button onClick={save} className="pressable" style={{width:"100%",marginTop:10,background:`linear-gradient(135deg,${T.accent},${T.blue})`,border:"none",borderRadius:14,color:"#fff",padding:"16px",fontSize:15,fontWeight:700,cursor:"pointer",letterSpacing:1,boxShadow:`0 4px 20px ${T.accent}40`}}>
        ✈ 비행기록 저장
      </button>
    </div>
  );
}

// ─── Flight List ──────────────────────────────────────────────────────────────
function FlightList({T,flights,onDetail,totals}) {
  const [q,setQ]=useState(""), [asc,setAsc]=useState(false);
  const list=flights.filter(f=>!q||[f.dep,f.arr,f.aircraft,f.acType,f.remarks,f.flightNum].some(v=>(v||"").toLowerCase().includes(q.toLowerCase()))).sort((a,b)=>asc?a.date.localeCompare(b.date):b.date.localeCompare(a.date));
  return (
    <div className="fu">
      <div style={{padding:"14px 16px 8px",display:"flex",gap:8}}>
        <div style={{flex:1,position:"relative"}}>
          <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:T.muted,fontSize:13}}>🔍</span>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="공항·기체·기종 검색..." style={{...iStyle(T),paddingLeft:32,marginBottom:0}}/>
        </div>
        <button onClick={()=>setAsc(!asc)} className="pressable" style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"0 12px",color:T.muted,cursor:"pointer",fontSize:16}}>{asc?"↑":"↓"}</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"76px 1fr 64px 56px",padding:"5px 18px",fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase"}}><span>날짜</span><span>노선/기체</span><span style={{textAlign:"center"}}>기종</span><span style={{textAlign:"right"}}>시간</span></div>
      <div style={{borderBottom:`1px solid ${T.border}`}}/>
      {list.length===0&&<div style={{textAlign:"center",color:T.muted,padding:40,fontSize:13}}>검색 결과 없음</div>}
      {list.map(f=>(
        <div key={f.id} className="rt" onClick={()=>onDetail(f)} style={{display:"grid",gridTemplateColumns:"76px 1fr 64px 56px",padding:"13px 18px",borderBottom:`1px solid ${T.dividerLine}`,cursor:"pointer"}}>
          <div style={{fontSize:11,color:T.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{f.date.slice(5)}</div>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:600,color:T.text}}>{f.dep}→{f.arr}</span>
              {f.flightNum&&<span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,color:T.accent,background:`${T.accent}18`,borderRadius:4,padding:"1px 5px",fontWeight:700}}>{f.flightNum}</span>}
            </div>
            <div style={{fontSize:10,color:T.muted,marginTop:1}}>{f.aircraft||"—"}</div>
          </div>
          <div style={{fontSize:10,color:T.muted,textAlign:"center",alignSelf:"center"}}>{f.acType||"—"}</div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:700,color:T.accent,textAlign:"right",alignSelf:"center"}}>{fmtH(f.total)}</div>
        </div>
      ))}
      <div style={{background:T.card,borderTop:`1px solid ${T.border}`,padding:"12px 18px",display:"flex",justifyContent:"space-between"}}>
        <span style={{fontSize:11,color:T.muted}}>총 {list.length}편</span>
        <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:T.accent}}>{fmtH(list.reduce((a,f)=>a+(f.total||0),0))}</span>
      </div>
    </div>
  );
}

// ─── Pay Tab ──────────────────────────────────────────────────────────────────
function PayTab({T, flights, profile, setProfile, notify}) {
  const rate = parseFloat(profile.hourlyRate)||0;
  const [selMonth, setSelMonth] = useState(today().slice(0,7));

  // 전체 월 목록
  const allMonths = [...new Set(flights.map(f=>f.date.slice(0,7)))].sort((a,b)=>b.localeCompare(a));
  const monthlyData = calcMonthPay(flights, rate);

  // 선택 월 비행 목록
  const monthFlights = flights.filter(f=>f.date.startsWith(selMonth)).sort((a,b)=>a.date.localeCompare(b.date));
  const selData = monthlyData[selMonth];

  // 연간 합계
  const yearTotal = Object.values(monthlyData).reduce((a,m)=>({
    rampHrs:a.rampHrs+m.rampHrs, nightHrs:a.nightHrs+m.nightHrs,
    overtimeHrs:a.overtimeHrs+m.overtimeHrs, totalPay:a.totalPay+m.totalPay,
    nightPay:a.nightPay+m.nightPay, overtimePay:a.overtimePay+m.overtimePay, basePay:a.basePay+m.basePay,
  }),{rampHrs:0,nightHrs:0,overtimeHrs:0,totalPay:0,nightPay:0,overtimePay:0,basePay:0});

  const PayCard = ({label, value, sub, color, big=false}) => (
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px"}}>
      <div style={{fontSize:8,color:T.muted,letterSpacing:2,textTransform:"uppercase"}}>{label}</div>
      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:big?22:16,fontWeight:700,color:color||T.accent,marginTop:4,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:9,color:T.muted,marginTop:4}}>{sub}</div>}
    </div>
  );

  return (
    <div style={{padding:"16px"}} className="fu">

      {/* 통상시급 설정 */}
      <div style={{background:rate>0?T.ok:T.warn, border:`1px solid ${rate>0?T.okBorder:T.warnBorder}`,borderRadius:14,padding:"14px 16px",marginBottom:16}}>
        <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>통상시급 설정 (프로필)</div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <div style={{position:"relative",flex:1}}>
            <input
              type="number" value={profile.hourlyRate||""} placeholder="예: 25000"
              onChange={e=>setProfile(p=>({...p,hourlyRate:e.target.value}))}
              style={{...iStyle(T),marginBottom:0,paddingRight:28,fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:T.orange,border:`1px solid ${T.orange}60`}}
            />
            <span style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",fontSize:11,color:T.muted}}>원/시</span>
          </div>
          {rate>0&&<div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,color:T.green,whiteSpace:"nowrap",fontWeight:600}}>✓ {rate.toLocaleString()}원/시</div>}
        </div>
        {!rate&&<div style={{fontSize:10,color:T.red,marginTop:6,fontWeight:600}}>⚠ 시급을 입력해야 수당이 계산됩니다</div>}
      </div>

      {rate>0 && (
        <>
          {/* 연간 요약 */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:14}}>
            <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:12}}>전체 기간 합계</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <div style={{gridColumn:"1/-1",background:`${T.accent}10`,border:`1px solid ${T.accent}40`,borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,color:T.accent,fontWeight:600}}>총 수령 예상액</span>
                <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:700,color:T.accent}}>{fmtWon(yearTotal.totalPay)}</span>
              </div>
              <PayCard label="기본급" value={fmtWon(yearTotal.basePay)} color={T.text}/>
              <PayCard label="야간 가산 (50%)" value={fmtWon(yearTotal.nightPay)} color={T.purple}/>
              <PayCard label="연장 가산 (50%)" value={fmtWon(yearTotal.overtimePay)} color={T.red}/>
              <PayCard label="총 Ramp 시간" value={fmtHrs(yearTotal.rampHrs)} color={T.orange}/>
              <PayCard label="야간 시간" value={fmtHrs(yearTotal.nightHrs)} color={T.purple}/>
              <PayCard label="연장 시간" value={fmtHrs(yearTotal.overtimeHrs)} color={T.red}/>
            </div>
          </div>

          {/* 월 선택 */}
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>월별 조회</div>
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:6,marginBottom:12}}>
            {allMonths.length===0
              ? <div style={{fontSize:11,color:T.muted}}>Ramp 시간이 입력된 기록이 없습니다</div>
              : allMonths.map(m=>(
                <button key={m} onClick={()=>setSelMonth(m)} className="pressable" style={{
                  flexShrink:0,padding:"7px 14px",borderRadius:20,border:`1px solid ${selMonth===m?T.accent:T.border}`,
                  background:selMonth===m?`${T.accent}18`:T.card,
                  color:selMonth===m?T.accent:T.muted,
                  fontSize:12,fontWeight:selMonth===m?700:400,cursor:"pointer",
                  fontFamily:"'IBM Plex Mono',monospace",
                }}>{m}</button>
              ))
            }
          </div>

          {/* 선택 월 상세 */}
          {selData ? (
            <>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
                <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:12}}>{selMonth} 수당 내역</div>
                <div style={{background:`${T.accent}10`,border:`1px solid ${T.accent}40`,borderRadius:10,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:12,color:T.accent,fontWeight:600}}>이달 수령 예상액</span>
                  <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:700,color:T.accent}}>{fmtWon(selData.totalPay)}</span>
                </div>

                {/* 수당 breakdown */}
                {[
                  {label:"기본급", formula:`${fmtHrs(selData.rampHrs)} × ${rate.toLocaleString()}원`, val:selData.basePay, color:T.text},
                  {label:"야간 가산 (+50%)", formula:`${fmtHrs(selData.nightHrs)} × ${(rate*0.5).toLocaleString()}원`, val:selData.nightPay, color:T.purple},
                  {label:"연장 가산 (+50%)", formula:`${fmtHrs(selData.overtimeHrs)} × ${(rate*0.5).toLocaleString()}원`, val:selData.overtimePay, color:T.red},
                ].map(row=>(
                  <div key={row.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${T.dividerLine}`}}>
                    <div>
                      <div style={{fontSize:12,color:T.text,fontWeight:600}}>{row.label}</div>
                      <div style={{fontSize:10,color:T.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{row.formula}</div>
                    </div>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:15,fontWeight:700,color:row.color}}>{fmtWon(row.val)}</div>
                  </div>
                ))}

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>
                  <PayCard label="Ramp 시간" value={fmtHrs(selData.rampHrs)} color={T.orange}/>
                  <PayCard label="야간 시간" value={fmtHrs(selData.nightHrs)} color={T.purple}/>
                  <PayCard label="연장 시간" value={fmtHrs(selData.overtimeHrs)} color={T.red}/>
                </div>
              </div>

              {/* 편별 목록 */}
              <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{selMonth} 편별 내역</div>
              {monthFlights.map(f=>{
                const p=calcPay(f,rate);
                return (
                  <div key={f.id} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:p?8:0}}>
                      <div>
                        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:700,color:T.text}}>{f.dep}→{f.arr}</div>
                        <div style={{fontSize:10,color:T.muted,marginTop:2}}>{f.date} · {f.acType}</div>
                      </div>
                      {p
                        ? <div style={{textAlign:"right"}}>
                            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:T.accent}}>{fmtWon(p.totalPay)}</div>
                            <div style={{fontSize:9,color:T.muted}}>Ramp {fmtHrs(p.rampHrs)}</div>
                          </div>
                        : <div style={{fontSize:10,color:T.muted,fontStyle:"italic"}}>Ramp 미입력</div>
                      }
                    </div>
                    {p&&(
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:4,paddingTop:8,borderTop:`1px solid ${T.dividerLine}`}}>
                        {[
                          {l:"기본",v:fmtWon(p.basePay),c:T.text},
                          {l:"야간↑",v:fmtWon(p.nightPay),c:T.purple},
                          {l:"연장↑",v:fmtWon(p.overtimePay),c:T.red},
                          {l:"RAMP OUT(UTC)",v:f.rampOutUtc||"—",c:T.orange},
                        ].map(s=>(
                          <div key={s.l} style={{textAlign:"center"}}>
                            <div style={{fontSize:9,color:T.muted}}>{s.l}</div>
                            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:10,fontWeight:600,color:s.c,marginTop:2}}>{s.v}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {monthFlights.length===0&&<div style={{textAlign:"center",color:T.muted,padding:30,fontSize:12}}>해당 월 비행기록 없음</div>}
            </>
          ) : (
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"30px",textAlign:"center"}}>
              <div style={{fontSize:32,marginBottom:8}}>📭</div>
              <div style={{color:T.muted,fontSize:13}}>선택한 월에 Ramp 시간이 입력된 기록이 없습니다</div>
            </div>
          )}

          {/* 계산 기준 안내 */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"13px 15px",marginTop:14}}>
            <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>계산 기준</div>
            {[
              ["야간 시간","22:00 ~ 익일 06:00 KST (Ramp 구간 기준)"],
              ["야간 가산","통상시급 × 50% × 야간 시간"],
              ["연장 기준","Ramp Out부터 8시간 초과 시 발생"],
              ["연장 가산","통상시급 × 50% × 연장 시간"],
              ["기본급","통상시급 × 전체 Ramp 시간"],
            ].map(([k,v])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"5px 0",borderBottom:`1px solid ${T.dividerLine}`}}>
                <span style={{fontSize:11,color:T.text,fontWeight:600,minWidth:70}}>{k}</span>
                <span style={{fontSize:10,color:T.muted,textAlign:"right",maxWidth:"65%"}}>{v}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function DetailModal({T,flight:f,onClose,onEdit,onDelete}) {
  const [confirm,setConfirm]=useState(false);
  return (
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:430,height:"100dvh",background:T.bg,zIndex:500,overflowY:"auto",animation:"fadeUp 0.25s ease"}}>
      <div style={{padding:"52px 16px 24px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:600,color:T.accent}}>FLIGHT DETAILS</span>
          <button onClick={onClose} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:16,width:34,height:34,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:16,padding:"20px",marginBottom:14,textAlign:"center"}}>
          {f.flightNum&&<div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:T.accent,letterSpacing:3,marginBottom:4,background:`${T.accent}15`,borderRadius:6,padding:"3px 10px",display:"inline-block"}}>{f.flightNum}</div>}
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:24,fontWeight:700,color:T.text,letterSpacing:2,marginTop:f.flightNum?4:0}}>{f.dep} → {f.arr}</div>
          <div style={{fontSize:12,color:T.muted,marginTop:4}}>{f.date}{f.depTime?` · ${f.depTime}–${f.arrTime}`:""}</div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:36,fontWeight:700,color:T.accent,marginTop:8,lineHeight:1}}>{fmtH(f.total)}</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          {[
            {l:"편명",v:f.flightNum||"—"},
            {l:"승무 형태",v:FDP_LABEL[parseInt(f.crew)||4]||"4인 승무"},
            {l:"기체",v:f.aircraft},
            {l:"기종",v:f.acType},
            {l:"기장(PIC)",v:fmtH(f.pic)},
            {l:"부기장(SIC)",v:fmtH(f.sic)},
            {l:"야간",v:fmtH(f.night)},
            {l:"계기(IFR)",v:fmtH(f.ifr)},
            {l:"이륙",v:f.to||0},
            {l:"주간착륙",v:f.ldDay||0},
            {l:"야간착륙",v:f.ldNight||0},
            {l:"기장성명",v:f.captain||"—"},
            {l:"부기장",v:f.fo||"—"},
          ].map(s=>(
            <div key={s.l} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"11px 13px"}}>
              <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase"}}>{s.l}</div>
              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:15,fontWeight:600,color:T.text,marginTop:3}}>{s.v||"—"}</div>
            </div>
          ))}
        </div>
        {f.remarks&&<div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"13px 15px",marginBottom:14}}>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:5}}>REMARKS</div>
          <div style={{fontSize:13,color:T.text,lineHeight:1.7}}>{f.remarks}</div>
        </div>}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <button onClick={()=>onEdit(f)} className="pressable" style={{background:T.card,border:`1px solid ${T.blue}`,borderRadius:12,color:T.blue,padding:"14px",fontSize:13,fontWeight:600,cursor:"pointer"}}>✎ 수정</button>
          <button onClick={()=>confirm?onDelete(f.id):setConfirm(true)} className="pressable" style={{background:confirm?T.red:T.card,border:`1px solid ${T.red}`,borderRadius:12,color:confirm?"#fff":T.red,padding:"14px",fontSize:13,fontWeight:600,cursor:"pointer",transition:"all 0.2s"}}>{confirm?"확인 삭제":"🗑 삭제"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Form Modal (Edit) ────────────────────────────────────────────────────────
function FormModal({T,initial,onSave,onClose,notify}) {
  const [f,setF]=useState({...initial,pic:fmt1(initial.pic),sic:fmt1(initial.sic),night:fmt1(initial.night),ifr:fmt1(initial.ifr),xc:fmt1(initial.xc)});
  const upd=(k,v)=>setF(p=>({...p,[k]:v}));
  const save=()=>{
    if(!f.dep||!f.arr){notify("출발지, 목적지를 입력하세요",true);return;}
    const total=decHrs(f.depTime,f.arrTime)||parseFloat(f.pic)||f.total||0;
    onSave({...f,total,pic:parseFloat(f.pic)||0,sic:parseFloat(f.sic)||0,night:parseFloat(f.night)||0,ifr:parseFloat(f.ifr)||0,xc:parseFloat(f.xc)||total,ldDay:parseInt(f.ldDay)||0,ldNight:parseInt(f.ldNight)||0,to:parseInt(f.to)||0});
  };
  return (
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:430,height:"100dvh",background:T.bg,zIndex:500,overflowY:"auto",animation:"fadeUp 0.25s ease"}}>
      <div style={{padding:"52px 16px 24px"}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:600,color:T.accent}}>EDIT FLIGHT</span>
          <button onClick={onClose} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:16,width:34,height:34,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
        {[["flightNum","편명 (Flight No.)"],["dep","출발 ICAO"],["arr","도착 ICAO"],["aircraft","기체 등록번호"],["acType","기종"],["captain","기장"],["fo","부기장"]].map(([k,l])=>(
          <div key={k}><Label T={T}>{l}</Label><input value={f[k]||""} onChange={e=>upd(k,e.target.value)} style={iStyle(T)}/></div>
        ))}
        <Label T={T}>👥 승무 형태 (FDP 기준)</Label>
        <select value={f.crew||"4"} onChange={e=>upd("crew",e.target.value)} style={{...iStyle(T),color:T.text,fontWeight:600}}>
          <option value="2">2인 승무 (FDP ≤13h)</option>
          <option value="3">3인 승무 (FDP ≤15h)</option>
          <option value="4">4인 승무 (FDP ≤18h)</option>
        </select>
        {[["pic","기장(PIC) 시간"],["sic","부기장(SIC) 시간"],["night","야간 시간"],["ifr","계기(IFR) 시간"],["xc","장거리(XC) 시간"]].map(([k,l])=>(
          <div key={k}><Label T={T}>{l}</Label><input type="number" step="0.01" value={f[k]||""} onChange={e=>upd(k,e.target.value)} style={iStyle(T)}/></div>
        ))}
        <div style={{background:`${T.green}10`,border:`2px solid ${T.green}50`,borderRadius:14,padding:"14px 16px",marginTop:8}}>
          <div style={{fontSize:9,color:T.green,letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:12}}>🛬 이착륙 — 90일 통화 관리</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            {[["to","✈ 이륙"],["ldDay","☀ 주간착륙"],["ldNight","🌙 야간착륙"]].map(([k,l])=>(
              <div key={k}>
                <div style={{fontSize:10,color:T.green,fontWeight:600,marginBottom:5,textAlign:"center"}}>{l}</div>
                <input type="number" min="0" value={f[k]||0} onChange={e=>upd(k,e.target.value)} style={{...iStyle(T),textAlign:"center",fontFamily:"'IBM Plex Mono',monospace",fontSize:20,fontWeight:700,color:T.green,border:`1px solid ${T.green}60`,padding:"12px 8px"}}/>
              </div>
            ))}
          </div>
        </div>
        <Label T={T}>비고</Label>
        <textarea value={f.remarks||""} onChange={e=>upd("remarks",e.target.value)} rows={3} style={{...iStyle(T),resize:"vertical"}}/>
        <button onClick={save} className="pressable" style={{width:"100%",marginTop:10,background:`linear-gradient(135deg,${T.accent},${T.blue})`,border:"none",borderRadius:14,color:"#fff",padding:"16px",fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:`0 4px 20px ${T.accent}40`}}>✓ 수정 저장</button>
      </div>
    </div>
  );
}

// ─── Profile Modal ────────────────────────────────────────────────────────────
function ProfileModal({T, profile, setProfile, onClose, notify}) {
  const [local, setLocal] = useState({...profile});
  const upd = (k,v) => setLocal(p=>({...p,[k]:v}));

  const FIELDS = [
    {k:"name",    label:"성명",              placeholder:"홍길동",            type:"text"},
    {k:"airline", label:"항공사 / 소속",      placeholder:"대한항공",           type:"text"},
    {k:"empNo",   label:"사번",              placeholder:"KAL-20001",        type:"text"},
    {k:"license", label:"자격증 번호",        placeholder:"ATPL-A 제2020-001호",type:"text"},
    {k:"medical", label:"의료증명 만료일",     placeholder:"",                  type:"date"},
    {k:"base",    label:"베이스 공항 (ICAO)", placeholder:"RKSI",             type:"text"},
    {k:"acTypes", label:"운항 기종",          placeholder:"B737-800, B777-300ER",type:"text"},
    {k:"hourlyRate",label:"통상시급 (원/시간)",placeholder:"예: 25000",         type:"number"},
  ];

  const save = () => {
    if(!local.name?.trim()||!local.airline?.trim()){
      notify("성명과 항공사는 필수입니다", true); return;
    }
    setProfile(local);
    notify("프로필이 저장되었습니다");
    onClose();
  };

  return (
    <div style={{
      position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",
      width:430,height:"100dvh",background:T.bg,zIndex:600,
      overflowY:"auto",animation:"fadeUp 0.25s ease",
    }}>
      <div style={{padding:"52px 16px 30px"}}>

        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
          <div>
            <div style={{fontSize:9,color:T.muted,letterSpacing:3,textTransform:"uppercase"}}>Edit Profile</div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:T.accent,letterSpacing:1,lineHeight:1.2}}>
              조종사 정보 편집
            </div>
          </div>
          <button onClick={onClose} className="pressable" style={{
            background:T.card,border:`1px solid ${T.border}`,borderRadius:10,
            color:T.text,fontSize:18,width:38,height:38,cursor:"pointer",
            display:"flex",alignItems:"center",justifyContent:"center",
          }}>✕</button>
        </div>

        {/* Avatar preview */}
        <div style={{
          background:T.card,border:`1px solid ${T.border}`,
          borderRadius:16,padding:"20px",textAlign:"center",marginBottom:20,
        }}>
          <div style={{
            width:64,height:64,borderRadius:"50%",margin:"0 auto 12px",
            background:`linear-gradient(135deg,${T.accent},${T.blue})`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:26,color:"#fff",fontWeight:700,
          }}>
            {local.name?.[0] || "✈"}
          </div>
          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:T.text}}>
            {local.name || "이름 없음"}
          </div>
          <div style={{fontSize:11,color:T.muted,marginTop:3}}>
            {local.airline || "소속 없음"}
          </div>
        </div>

        {/* Fields */}
        {FIELDS.map(({k,label,placeholder,type})=>(
          <div key={k}>
            <Label T={T}>{label}</Label>
            <input
              type={type}
              value={local[k]||""}
              onChange={e=>upd(k,e.target.value)}
              placeholder={placeholder}
              style={{
                ...iStyle(T),
                fontSize:14,
                borderColor: (k==="name"||k==="airline")&&!local[k]?.trim() ? T.red : T.border,
              }}
            />
          </div>
        ))}

        {/* Note */}
        <div style={{
          background:T.card,border:`1px solid ${T.border}`,borderRadius:12,
          padding:"12px 14px",marginTop:14,marginBottom:20,
          fontSize:11,color:T.muted,lineHeight:1.6,
        }}>
          💡 성명과 항공사는 앱 상단에 표시됩니다. 변경 후 저장하면 즉시 반영됩니다.
        </div>

        {/* Buttons */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 2fr",gap:10}}>
          <button onClick={onClose} className="pressable" style={{
            background:T.card,border:`1px solid ${T.border}`,borderRadius:14,
            color:T.muted,padding:"15px",fontSize:14,fontWeight:600,cursor:"pointer",
          }}>취소</button>
          <button onClick={save} className="pressable" style={{
            background:`linear-gradient(135deg,${T.accent},${T.blue})`,
            border:"none",borderRadius:14,color:"#fff",
            padding:"15px",fontSize:14,fontWeight:700,cursor:"pointer",
            boxShadow:`0 4px 20px ${T.accent}40`,letterSpacing:0.5,
          }}>✓ 저장</button>
        </div>
      </div>
    </div>
  );
}
