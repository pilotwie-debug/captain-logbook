import { useState, useEffect, useCallback, useRef } from "react";

// ─── Storage ──────────────────────────────────────────────────────────────────
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
  RKTU:"청주국제공항",RKJJ:"광주공항",RJTT:"도쿄 하네다",RJAA:"도쿄 나리타",
  RJOO:"오사카 이타미",RJBB:"오사카 간사이",RJFF:"후쿠오카",RJCC:"삿포로",
  ZGGG:"광저우",ZBAA:"베이징 캐피탈",ZSSS:"상하이 훙차오",ZSPD:"상하이 푸둥",
  VHHH:"홍콩",RCTP:"타이베이 타오위안",VTBS:"방콕 수완나품",WSSS:"싱가포르 창이",
  WMKK:"쿠알라룸푸르",WADD:"발리",OMDB:"두바이",OTHH:"도하 하마드",
  EGLL:"런던 히드로",LFPG:"파리 드골",EDDF:"프랑크푸르트",EHAM:"암스테르담",
  KLAX:"로스앤젤레스",KJFK:"뉴욕 JFK",KORD:"시카고",KSFO:"샌프란시스코",
  KATL:"애틀란타",KDFW:"댈러스",CYYZ:"토론토",YSSY:"시드니",YMML:"멜버른",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const decHrs=(dep,arr)=>{if(!dep||!arr)return 0;const[dh,dm]=dep.split(":").map(Number),[ah,am]=arr.split(":").map(Number);let m=ah*60+am-(dh*60+dm);if(m<0)m+=1440;return Math.round(m/60*100)/100;};
const fmtH=(dec)=>{const h=Math.floor(dec||0),m=Math.round(((dec||0)-h)*60);return`${h}:${String(m).padStart(2,"0")}`;};
const fmt1=(n)=>(+(n||0)).toFixed(1);
const today=()=>new Date().toISOString().slice(0,10);
const daysAgo=(n)=>{const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().slice(0,10);};
const KST_OFFSET=9*60;
const timeToMins=(hhmm)=>{if(!hhmm)return null;const[h,m]=hhmm.split(":").map(Number);return h*60+m;};
const utcMinsToKst=(u)=>(u+KST_OFFSET)%1440;

const FDP_LIMITS={2:12,3:16,4:20};
const FDP_LABEL={2:"2인 승무",3:"3인 승무",4:"4인 승무"};
const fmtWon=(n)=>Math.round(n||0).toLocaleString("ko-KR")+"원";
const fmtHrs=(h)=>{const hh=Math.floor(h||0),mm=Math.round(((h||0)-hh)*60);return`${hh}:${String(mm).padStart(2,"0")}`;};

const calcRamp=(f)=>{
  const ro=timeToMins(f.rampOutUtc),ri=timeToMins(f.rampInUtc);
  if(ro===null||ri===null)return null;
  let mins=ri-ro;if(mins<=0)mins+=1440;
  const hrs=mins/60,crew=parseInt(f.crew)||4,lim=FDP_LIMITS[crew]||13;
  const roK=utcMinsToKst(ro),riK=utcMinsToKst(ri);
  const hm=(m)=>`${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
  return{hrs,lim,crew,exceeds:hrs>lim,pct:Math.min(100,hrs/lim*100),roKst:hm(roK),riKst:hm(riK)};
};

// 야간근무시간(분) 계산: startUtcMins부터 durMins 동안 KST 22:00~06:00 구간
const calcNightWorkMins=(startUtcMins,durMins)=>{
  const NIGHT_START=22*60,NIGHT_END=6*60; // KST 기준
  let n=0;
  for(let i=0;i<durMins;i++){
    const kst=(startUtcMins+i+KST_OFFSET)%1440;
    if(kst>=NIGHT_START||kst<NIGHT_END)n++;
  }
  return n;
};

// 통합 수당 계산
// - 야간수당: showUp ~ rampIn+30분 구간 중 KST 22:00~06:00 × 통상시급 × 0.5
// - 연장수당(비행수당): rampOut ~ rampIn 비행시간 × 비행수당 × 0.5
// - 3P수당: crew=3 시 비행시간 × 비행수당 × 0.25
const calcPay=(f,hourlyRate,flightRate)=>{
  const hr=parseFloat(hourlyRate)||0;
  const fr=parseFloat(flightRate)||0;
  if(hr<=0&&fr<=0)return null;

  const ro=timeToMins(f.rampOutUtc),ri=timeToMins(f.rampInUtc);
  const su=timeToMins(f.showUpUtc); // Show Up UTC
  const crew=parseInt(f.crew)||4;

  // 비행시간(Ramp Out→In)
  let flightMins=0,flightHrs=0;
  if(ro!==null&&ri!==null){
    flightMins=ri-ro;if(flightMins<=0)flightMins+=1440;
    flightHrs=flightMins/60;
  }

  // 야간수당 계산: Show Up(없으면 Ramp Out) ~ Ramp In + 30분
  let nightHrs=0;
  if(ri!==null){
    const wStart=su!==null?su:ro; // Show Up이 있으면 Show Up부터
    if(wStart!==null){
      const wEnd=ri+30; // Ramp In +30분
      let wDur=wEnd-wStart;if(wDur<=0)wDur+=1440;
      nightHrs=calcNightWorkMins(wStart,wDur)/60;
    }
  }

  // 기본 비행수당 (비행시간 × 비행수당)
  const flightBase=flightHrs*fr;
  // 연장수당: 비행시간 × 비행수당 × 0.5
  const overtime=flightHrs>0?flightHrs*fr*0.5:0;
  // 3P 수당: crew=3일 때 비행시간 × 비행수당 × 0.25
  const threePBonus=(crew===3&&flightHrs>0)?flightHrs*fr*0.25:0;
  // 야간수당: 야간근무시간 × 통상시급 × 0.5
  const nightBonus=nightHrs*hr*0.5;

  const total=flightBase+overtime+threePBonus+nightBonus;
  return{flightHrs,nightHrs,crew,flightBase,overtime,threePBonus,nightBonus,total};
};

// 초과비행수당: 월 누적 비행시간 구간별 가산 (70h 초과분부터)
// 70~75h: +10%, 76~85h: +25%, 86~95h: +50%, 95h초과: +80%
const EXCESS_BANDS=[
  {from:70,to:75, rate:0.10,label:"70~75h +10%"},
  {from:75,to:85, rate:0.25,label:"76~85h +25%"},
  {from:85,to:95, rate:0.50,label:"86~95h +50%"},
  {from:95,to:Infinity,rate:0.80,label:"95h초과 +80%"},
];
const calcExcessFlightPay=(totalMonthHrs,flightRate)=>{
  const fr=parseFloat(flightRate)||0;
  if(fr<=0||totalMonthHrs<=70)return{excessPay:0,bands:[]};
  let excessPay=0;
  const bands=[];
  for(const b of EXCESS_BANDS){
    if(totalMonthHrs<=b.from)break;
    const upper=b.to===Infinity?totalMonthHrs:Math.min(totalMonthHrs,b.to);
    const hrs=upper-b.from;
    if(hrs<=0)continue;
    const pay=hrs*fr*b.rate;
    excessPay+=pay;
    bands.push({label:b.label,hrs,pay});
  }
  return{excessPay,bands};
};

const computeCompliance=(flights)=>{
  const now=today(),d28=daysAgo(28),d90=daysAgo(90),d365=daysAgo(365);
  const inR=(f,from)=>f.date>=from&&f.date<=now;
  const hrs28=flights.filter(f=>inR(f,d28)).reduce((a,f)=>a+(f.total||0),0);
  const hrs90=flights.filter(f=>inR(f,d90)).reduce((a,f)=>a+(f.total||0),0);
  const hrs365=flights.filter(f=>inR(f,d365)).reduce((a,f)=>a+(f.total||0),0);
  const in90=flights.filter(f=>inR(f,d90));
  const to90=in90.reduce((a,f)=>a+(f.to||0),0);
  const ld90=in90.reduce((a,f)=>a+(f.ldDay||0),0);
  const toEvts=in90.flatMap(f=>Array(f.to||0).fill(f.date)).sort((a,b)=>b.localeCompare(a));
  const ldEvts=in90.flatMap(f=>Array(f.ldDay||0).fill(f.date)).sort((a,b)=>b.localeCompare(a));
  const expiry=(evts,req=3)=>{if(evts.length<req)return null;const a=new Date(evts[req-1]);a.setDate(a.getDate()+90);return a.toISOString().slice(0,10);};
  const dl=(e)=>e?Math.ceil((new Date(e)-new Date())/86400000):null;
  const toExp=expiry(toEvts),ldExp=expiry(ldEvts);
  return{hrs28,hrs90,hrs365,to90,ld90,toExp,ldExp,toD:dl(toExp),ldD:dl(ldExp),toOk:to90>=3,ldOk:ld90>=3};
};

// ─── Sample Data ──────────────────────────────────────────────────────────────
const makeSample=()=>[
  {id:1000,date:"2026-02-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:5.57,sic:0,total:5.57,night:3.0,ifr:11.13,xc:5.57,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1001,date:"2026-02-11",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:4.5,sic:0,total:4.5,night:4.5,ifr:5.18,xc:4.5,ldDay:0,to:0,flightNum:"KE602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1002,date:"2026-02-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.97,sic:0,total:5.97,night:4.5,ifr:5.97,xc:5.97,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1003,date:"2026-01-29",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8704",acType:"B787-9",pic:7.25,sic:0,total:7.25,night:2.0,ifr:7.25,xc:7.25,ldDay:1,to:1,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1004,date:"2026-01-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:4.97,sic:0,total:4.97,night:0,ifr:4.97,xc:4.97,ldDay:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1005,date:"2026-01-17",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.17,sic:0,total:6.17,night:0,ifr:6.17,xc:6.17,ldDay:1,to:1,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1006,date:"2026-01-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.47,sic:0,total:5.47,night:3.83,ifr:5.47,xc:5.47,ldDay:0,to:1,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1007,date:"2026-01-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.73,sic:0,total:4.73,night:4.33,ifr:4.73,xc:4.73,ldDay:0,to:1,flightNum:"KE621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1008,date:"2025-12-25",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.25,sic:0,total:4.25,night:3.17,ifr:4.25,xc:4.25,ldDay:1,to:1,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1009,date:"2025-12-16",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.07,sic:0,total:4.07,night:3.58,ifr:4.07,xc:4.07,ldDay:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1010,date:"2025-12-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.07,sic:0,total:5.07,night:4.5,ifr:5.07,xc:5.07,ldDay:0,to:0,flightNum:"KE103",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1011,date:"2025-12-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:5.25,sic:0,total:5.25,night:0,ifr:5.25,xc:5.25,ldDay:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1012,date:"2025-12-03",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.25,sic:0,total:5.25,night:0,ifr:5.25,xc:5.25,ldDay:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1013,date:"2025-12-08",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.83,sic:0,total:2.83,night:0,ifr:2.83,xc:2.83,ldDay:0,to:0,flightNum:"KE732",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1014,date:"2025-12-05",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8703",acType:"B787-9",pic:2.3,sic:0,total:2.3,night:1.8,ifr:2.3,xc:2.3,ldDay:0,to:0,flightNum:"KE731",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1015,date:"2025-12-04",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.58,sic:0,total:5.58,night:0,ifr:13.1,xc:5.58,ldDay:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1016,date:"2025-11-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:11.23,sic:0,total:11.23,night:0,ifr:11.23,xc:11.23,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1017,date:"2025-11-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.68,sic:0,total:2.68,night:2.18,ifr:2.68,xc:2.68,ldDay:0,to:1,flightNum:"KE732",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1018,date:"2025-11-20",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:2.02,sic:0,total:2.02,night:1.67,ifr:2.02,xc:2.02,ldDay:0,to:0,flightNum:"KE104",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1019,date:"2025-11-13",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:6.75,sic:0,total:6.75,night:0,ifr:13.5,xc:6.75,ldDay:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1020,date:"2025-10-24",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8703",acType:"B787-9",pic:5.5,sic:0,total:5.5,night:5.22,ifr:5.5,xc:5.5,ldDay:0,to:1,flightNum:"KE151",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1021,date:"2025-10-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.57,sic:0,total:6.57,night:0,ifr:6.57,xc:6.57,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1022,date:"2025-10-07",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:6.48,sic:0,total:6.48,night:3.03,ifr:6.48,xc:6.48,ldDay:0,to:0,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1023,date:"2025-10-06",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.65,sic:0,total:5.65,night:0,ifr:5.65,xc:5.65,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1024,date:"2025-10-01",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.55,sic:0,total:6.55,night:0,ifr:13.1,xc:6.55,ldDay:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1025,date:"2025-09-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:5.07,sic:0,total:5.07,night:2.5,ifr:5.07,xc:5.07,ldDay:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1026,date:"2025-09-16",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:4.5,sic:0,total:4.5,night:0,ifr:4.5,xc:4.5,ldDay:1,to:1,flightNum:"KE5202",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1027,date:"2025-09-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:5.78,sic:0,total:5.78,night:0,ifr:11.57,xc:5.78,ldDay:1,to:1,flightNum:"KE5201",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1028,date:"2025-09-04",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.27,sic:0,total:6.27,night:4.93,ifr:6.27,xc:6.27,ldDay:0,to:0,flightNum:"KE152",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1029,date:"2025-08-29",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:5.83,sic:0,total:5.83,night:0,ifr:5.83,xc:5.83,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1030,date:"2025-08-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.28,sic:0,total:6.28,night:0,ifr:12.57,xc:6.28,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1031,date:"2025-08-26",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:1.92,sic:0,total:1.92,night:1.92,ifr:1.92,xc:1.92,ldDay:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1032,date:"2025-08-17",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:7.78,sic:0,total:7.78,night:0.78,ifr:7.78,xc:7.78,ldDay:0,to:0,flightNum:"KE131",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1033,date:"2025-08-14",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:3.82,sic:0,total:3.82,night:0,ifr:3.82,xc:3.82,ldDay:0,to:0,flightNum:"KE131",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1034,date:"2025-08-09",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:6.15,sic:0,total:6.15,night:0,ifr:12.3,xc:6.15,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1035,date:"2025-08-08",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:6.37,sic:0,total:6.37,night:0,ifr:12.75,xc:6.37,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1036,date:"2025-07-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:5.52,sic:0,total:5.52,night:0.5,ifr:5.52,xc:5.52,ldDay:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1037,date:"2025-07-21",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:6.02,sic:0,total:6.02,night:0,ifr:12.03,xc:6.02,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1038,date:"2025-07-12",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.32,sic:0,total:4.32,night:3.87,ifr:4.32,xc:4.32,ldDay:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1039,date:"2025-07-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:4.45,sic:0,total:4.45,night:4.03,ifr:4.45,xc:4.45,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1040,date:"2025-06-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:1.3,sic:0,total:1.3,night:1.3,ifr:1.3,xc:1.3,ldDay:0,to:0,flightNum:"KE132",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1041,date:"2025-06-28",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:2.28,sic:0,total:2.28,night:1.83,ifr:2.28,xc:2.28,ldDay:0,to:0,flightNum:"KE731",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1042,date:"2025-06-20",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:5.63,sic:0,total:5.63,night:2.25,ifr:11.28,xc:5.63,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1043,date:"2025-06-13",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.67,sic:0,total:6.67,night:0,ifr:6.67,xc:6.67,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1044,date:"2025-06-01",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:6.15,sic:0,total:6.15,night:0,ifr:12.3,xc:6.15,ldDay:0,to:0,flightNum:"KE112",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1045,date:"2025-06-03",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8517",acType:"B787-9",pic:5.3,sic:0,total:5.3,night:2.58,ifr:5.3,xc:5.3,ldDay:0,to:0,flightNum:"KE111",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1046,date:"2025-05-11",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8702",acType:"B787-9",pic:3.98,sic:0,total:3.98,night:4.65,ifr:3.98,xc:3.98,ldDay:0,to:0,flightNum:"KE622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1047,date:"2025-05-10",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:6.42,sic:0,total:6.42,night:0,ifr:12.85,xc:6.42,ldDay:0,to:0,flightNum:"KE102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:1048,date:"2025-04-30",dep:"RKSI",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:5.63,sic:0,total:5.63,night:0,ifr:11.28,xc:5.63,ldDay:0,to:0,flightNum:"KE101",crew:"4",remarks:"",captain:"위종석",fo:""},

  // ─── 에어프레미아 비행기록 (로그북 PDF 판독, 2023~2026) ──────────────────────
  {id:2001,date:"2023-09-06",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:1.2,total:1.2,night:0,ifr:1.2,xc:1.2,ldDay:0,to:0,flightNum:"YP541",crew:"4",remarks:"DE 1/4 전환교육",captain:"위종석",fo:""},
  {id:2002,date:"2023-09-07",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:1.3,total:1.3,night:0,ifr:1.3,xc:1.3,ldDay:0,to:0,flightNum:"YP541",crew:"4",remarks:"DE 1/4",captain:"위종석",fo:""},
  {id:2003,date:"2023-09-10",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8382",acType:"B787-9",pic:0,sic:1.22,total:1.22,night:0,ifr:1.22,xc:1.22,ldDay:0,to:0,flightNum:"YP543",crew:"4",remarks:"DE 1/4",captain:"위종석",fo:""},
  {id:2004,date:"2023-09-16",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8382",acType:"B787-9",pic:0,sic:1.02,total:1.02,night:1.35,ifr:1.02,xc:1.02,ldDay:0,to:0,flightNum:"YP543",crew:"4",remarks:"LDP 도착후",captain:"위종석",fo:""},
  {id:2005,date:"2023-09-17",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:1.78,total:1.78,night:1.15,ifr:1.78,xc:1.78,ldDay:0,to:0,flightNum:"YP542",crew:"4",remarks:"DE 1/4",captain:"위종석",fo:""},
  {id:2006,date:"2023-09-17",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:1.27,total:1.27,night:0.1,ifr:1.27,xc:1.27,ldDay:0,to:0,flightNum:"YP541",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2007,date:"2023-09-19",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:0,sic:6.73,total:6.73,night:1.02,ifr:6.73,xc:6.73,ldDay:0,to:0,flightNum:"YP542",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2008,date:"2023-09-19",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:0,sic:11.02,total:11.02,night:1.35,ifr:11.02,xc:11.02,ldDay:1,to:0,flightNum:"YP541",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2009,date:"2023-09-25",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:0,sic:11.02,total:11.02,night:1.7,ifr:11.02,xc:11.02,ldDay:0,to:1,flightNum:"YP542",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2010,date:"2024-01-16",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:1.2,total:1.2,night:3.0,ifr:1.2,xc:1.2,ldDay:0,to:0,flightNum:"YP621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2011,date:"2024-01-16",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8502",acType:"B787-9",pic:0,sic:1.2,total:1.2,night:3.0,ifr:1.2,xc:1.2,ldDay:0,to:0,flightNum:"YP621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2012,date:"2024-02-05",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:6.48,total:6.48,night:2.0,ifr:6.48,xc:6.48,ldDay:0,to:0,flightNum:"YP631",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2013,date:"2024-02-06",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8502",acType:"B787-9",pic:0,sic:6.48,total:6.48,night:2.0,ifr:6.48,xc:6.48,ldDay:0,to:1,flightNum:"YP632",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2014,date:"2024-02-09",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:4.48,total:4.48,night:2.77,ifr:4.48,xc:4.48,ldDay:0,to:0,flightNum:"YP631",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2015,date:"2024-02-10",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8502",acType:"B787-9",pic:0,sic:4.35,total:4.35,night:2.77,ifr:4.35,xc:4.35,ldDay:1,to:1,flightNum:"YP632",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2020,date:"2023-05-11",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:5.58,total:5.58,night:2.0,ifr:5.58,xc:5.58,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"초항",captain:"위종석",fo:""},
  {id:2021,date:"2023-05-12",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:4.48,total:4.48,night:0.0,ifr:4.48,xc:4.48,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2022,date:"2023-06-04",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8585",acType:"B787-9",pic:0,sic:11.38,total:11.38,night:2.0,ifr:11.38,xc:11.38,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2023,date:"2023-06-07",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8585",acType:"B787-9",pic:0,sic:13.8,total:13.8,night:2.8,ifr:13.8,xc:13.8,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"check 비행",captain:"위종석",fo:""},
  {id:2024,date:"2023-07-01",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.02,total:11.02,night:0.0,ifr:11.02,xc:11.02,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"초항",captain:"위종석",fo:""},
  {id:2025,date:"2023-07-04",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:1.68,total:1.68,night:0.0,ifr:1.68,xc:1.68,ldDay:0,to:0,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2030,date:"2023-06-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8385",acType:"B787-9",pic:0,sic:11.38,total:11.38,night:2.0,ifr:11.38,xc:11.38,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2031,date:"2023-06-17",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8385",acType:"B787-9",pic:0,sic:13.07,total:13.07,night:3.8,ifr:13.07,xc:13.07,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2032,date:"2023-07-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:11.28,total:11.28,night:3.0,ifr:11.28,xc:11.28,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2033,date:"2023-07-17",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8387",acType:"B787-9",pic:0,sic:13.08,total:13.08,night:4.0,ifr:13.08,xc:13.08,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2034,date:"2023-07-21",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:0,sic:11.02,total:11.02,night:0.0,ifr:11.02,xc:11.02,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2035,date:"2023-07-23",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8388",acType:"B787-9",pic:0,sic:13.42,total:13.42,night:4.0,ifr:13.42,xc:13.42,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2040,date:"2024-01-01",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8102",acType:"B787-9",pic:0,sic:11.58,total:11.58,night:0.0,ifr:11.58,xc:11.58,ldDay:1,to:0,flightNum:"YP621",crew:"4",remarks:"YP기장 초항 첫비행",captain:"위종석",fo:""},
  {id:2041,date:"2024-01-02",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8102",acType:"B787-9",pic:0,sic:12.37,total:12.37,night:0.0,ifr:12.37,xc:12.37,ldDay:0,to:1,flightNum:"YP622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2042,date:"2024-01-10",dep:"VVDN",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:3.85,total:3.85,night:0.0,ifr:3.85,xc:3.85,ldDay:0,to:0,flightNum:"YP1521",crew:"4",remarks:"다낭",captain:"위종석",fo:""},
  {id:2043,date:"2024-01-12",dep:"RKSI",arr:"PHNL",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8515",acType:"B787-9",pic:0,sic:10.55,total:10.55,night:0.0,ifr:10.55,xc:10.55,ldDay:1,to:0,flightNum:"YP2101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2044,date:"2024-01-14",dep:"PHNL",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8515",acType:"B787-9",pic:0,sic:10.82,total:10.82,night:4.0,ifr:10.82,xc:10.82,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2045,date:"2024-02-06",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8515",acType:"B787-9",pic:0,sic:10.55,total:10.55,night:0.0,ifr:10.55,xc:10.55,ldDay:1,to:0,flightNum:"YP621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2046,date:"2024-02-07",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8515",acType:"B787-9",pic:0,sic:13.82,total:13.82,night:0.0,ifr:13.82,xc:13.82,ldDay:0,to:1,flightNum:"YP622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2047,date:"2024-02-09",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:10.32,total:10.32,night:0.0,ifr:10.32,xc:10.32,ldDay:1,to:0,flightNum:"YP2211",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2048,date:"2024-02-12",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.07,total:12.07,night:0.0,ifr:12.07,xc:12.07,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2050,date:"2024-02-29",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8940",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:4.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장 CATB이상 처리",captain:"위종석",fo:""},
  {id:2051,date:"2024-03-04",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8940",acType:"B787-9",pic:13.0,sic:0,total:13.0,night:4.0,ifr:13.0,xc:13.0,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"CATB 이상",captain:"위종석",fo:""},
  {id:2052,date:"2024-03-07",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2053,date:"2024-03-09",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:13.0,sic:0,total:13.0,night:2.0,ifr:13.0,xc:13.0,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2054,date:"2024-03-14",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8839",acType:"B787-9",pic:11.92,sic:0,total:11.92,night:0.0,ifr:11.92,xc:11.92,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2055,date:"2024-03-17",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8839",acType:"B787-9",pic:11.88,sic:0,total:11.88,night:0.0,ifr:11.88,xc:11.88,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2056,date:"2024-03-19",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8840",acType:"B787-9",pic:11.7,sic:0,total:11.7,night:0.0,ifr:11.7,xc:11.7,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2057,date:"2024-03-21",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8840",acType:"B787-9",pic:12.17,sic:0,total:12.17,night:2.0,ifr:12.17,xc:12.17,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2058,date:"2024-04-01",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8843",acType:"B787-9",pic:11.25,sic:0,total:11.25,night:4.0,ifr:11.25,xc:11.25,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2060,date:"2023-06-07",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.1,total:12.1,night:3.0,ifr:12.1,xc:12.1,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2061,date:"2023-06-10",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.67,total:13.67,night:10.0,ifr:13.67,xc:13.67,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2062,date:"2023-06-19",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.02,total:13.02,night:6.0,ifr:13.02,xc:13.02,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2063,date:"2023-07-01",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.1,total:12.1,night:0.0,ifr:12.1,xc:12.1,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2064,date:"2023-07-04",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:0,sic:12.1,total:12.1,night:0.0,ifr:12.1,xc:12.1,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2065,date:"2023-07-08",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.1,total:12.1,night:0.0,ifr:12.1,xc:12.1,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2066,date:"2023-07-10",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:13.75,total:13.75,night:0.0,ifr:13.75,xc:13.75,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2067,date:"2023-07-18",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.42,total:11.42,night:0.0,ifr:11.42,xc:11.42,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2070,date:"2023-07-15",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:11.63,total:11.63,night:6.0,ifr:11.63,xc:11.63,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2071,date:"2023-07-31",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8583",acType:"B787-9",pic:0,sic:12.53,total:12.53,night:0.0,ifr:12.53,xc:12.53,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2072,date:"2023-08-05",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.6,total:12.6,night:6.0,ifr:12.6,xc:12.6,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2073,date:"2023-08-12",dep:"RKSI",arr:"EDDF",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.55,total:12.55,night:0.0,ifr:12.55,xc:12.55,ldDay:1,to:0,flightNum:"YP801",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2074,date:"2023-08-16",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.42,total:11.42,night:0.0,ifr:11.42,xc:11.42,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2075,date:"2023-08-23",dep:"RKSI",arr:"EDDF",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:12.0,total:12.0,night:0.0,ifr:12.0,xc:12.0,ldDay:1,to:0,flightNum:"YP801",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2076,date:"2023-08-28",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:0,sic:6.47,total:6.47,night:0.0,ifr:6.47,xc:6.47,ldDay:0,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2077,date:"2023-09-04",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8516",acType:"B787-9",pic:0,sic:6.45,total:6.45,night:5.55,ifr:6.45,xc:6.45,ldDay:0,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2080,date:"2023-09-12",dep:"EDDF",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:11.47,total:11.47,night:0.0,ifr:11.47,xc:11.47,ldDay:0,to:1,flightNum:"YP802",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2081,date:"2023-09-15",dep:"RKSI",arr:"EDDF",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.88,total:12.88,night:0.0,ifr:12.88,xc:12.88,ldDay:1,to:0,flightNum:"YP801",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2082,date:"2023-09-29",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.88,total:12.88,night:5.0,ifr:12.88,xc:12.88,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2083,date:"2023-10-01",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.88,total:12.88,night:0.0,ifr:12.88,xc:12.88,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2084,date:"2023-10-08",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.28,total:12.28,night:0.0,ifr:12.28,xc:12.28,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2085,date:"2023-10-13",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.88,total:12.88,night:15.23,ifr:12.88,xc:12.88,ldDay:0,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2086,date:"2023-10-15",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8833",acType:"B787-9",pic:0,sic:11.83,total:11.83,night:0.0,ifr:11.83,xc:11.83,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2087,date:"2023-11-09",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8367",acType:"B787-9",pic:0,sic:11.75,total:11.75,night:0.0,ifr:11.75,xc:11.75,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2088,date:"2023-11-15",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8367",acType:"B787-9",pic:0,sic:11.83,total:11.83,night:0.0,ifr:11.83,xc:11.83,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2090,date:"2023-11-06",dep:"RKSI",arr:"RJAA",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8935",acType:"B787-9",pic:0,sic:2.37,total:2.37,night:0.0,ifr:2.37,xc:2.37,ldDay:1,to:0,flightNum:"YP321",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2091,date:"2023-11-08",dep:"RJAA",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8935",acType:"B787-9",pic:0,sic:2.37,total:2.37,night:0.0,ifr:2.37,xc:2.37,ldDay:0,to:1,flightNum:"YP322",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2092,date:"2023-11-12",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.17,total:13.17,night:4.0,ifr:13.17,xc:13.17,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2093,date:"2023-11-15",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.25,total:13.25,night:0.0,ifr:13.25,xc:13.25,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2094,date:"2023-11-18",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:6.0,total:6.0,night:0.0,ifr:6.0,xc:6.0,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2095,date:"2023-11-23",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:5.5,total:5.5,night:0.0,ifr:5.5,xc:5.5,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2096,date:"2023-11-25",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.25,total:13.25,night:0.0,ifr:13.25,xc:13.25,ldDay:1,to:0,flightNum:"YP601",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2097,date:"2023-12-02",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.25,total:13.25,night:5.0,ifr:13.25,xc:13.25,ldDay:0,to:1,flightNum:"YP602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2098,date:"2023-12-13",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.17,total:13.17,night:2.0,ifr:13.17,xc:13.17,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2099,date:"2023-12-20",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.0,total:13.0,night:0.0,ifr:13.0,xc:13.0,ldDay:0,to:1,flightNum:"YP602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2100,date:"2024-01-02",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8283",acType:"B787-9",pic:0,sic:4.8,total:4.8,night:4.97,ifr:4.8,xc:4.8,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2101,date:"2024-01-05",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8283",acType:"B787-9",pic:0,sic:5.0,total:5.0,night:0.0,ifr:5.0,xc:5.0,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2102,date:"2024-01-06",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8283",acType:"B787-9",pic:0,sic:5.0,total:5.0,night:0.0,ifr:5.0,xc:5.0,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2103,date:"2024-01-13",dep:"RKSI",arr:"RJAA",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:0,sic:2.5,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:1,to:0,flightNum:"YP321",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2104,date:"2024-01-14",dep:"RJAA",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:0,sic:2.5,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:0,to:1,flightNum:"YP322",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2105,date:"2024-01-28",dep:"RKSI",arr:"KEWR",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8395",acType:"B787-9",pic:0,sic:14.23,total:14.23,night:0.0,ifr:14.23,xc:14.23,ldDay:1,to:0,flightNum:"YP2401",crew:"4",remarks:"뉴욕 EWR 초항",captain:"위종석",fo:""},
  {id:2106,date:"2024-02-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8395",acType:"B787-9",pic:0,sic:10.17,total:10.17,night:1.0,ifr:10.17,xc:10.17,ldDay:1,to:0,flightNum:"YP621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2107,date:"2024-02-19",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8395",acType:"B787-9",pic:0,sic:11.0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:0,flightNum:"YP621",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2108,date:"2024-02-20",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8395",acType:"B787-9",pic:0,sic:13.0,total:13.0,night:1.0,ifr:13.0,xc:13.0,ldDay:0,to:1,flightNum:"YP622",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2110,date:"2024-03-12",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:13.83,total:13.83,night:0.0,ifr:13.83,xc:13.83,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2111,date:"2024-03-15",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:5.5,total:5.5,night:0.0,ifr:5.5,xc:5.5,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2112,date:"2024-03-19",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:5.0,total:5.0,night:0.0,ifr:5.0,xc:5.0,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2113,date:"2024-04-12",dep:"RKSI",arr:"RJAA",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:2.5,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:1,to:0,flightNum:"YP321",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2114,date:"2024-04-13",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:5.5,total:5.5,night:0.0,ifr:5.5,xc:5.5,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2115,date:"2024-04-29",dep:"KEWR",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:14.0,total:14.0,night:0.0,ifr:14.0,xc:14.0,ldDay:0,to:1,flightNum:"YP2402",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2116,date:"2024-05-01",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:14.0,total:14.0,night:0.0,ifr:14.0,xc:14.0,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2117,date:"2024-05-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8040",acType:"B787-9",pic:0,sic:11.0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2120,date:"2024-05-20",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.5,total:11.5,night:4.0,ifr:11.5,xc:11.5,ldDay:1,to:0,flightNum:"YP601",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2121,date:"2024-05-24",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.5,total:13.5,night:0.0,ifr:13.5,xc:13.5,ldDay:0,to:1,flightNum:"YP602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2122,date:"2024-06-04",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.5,total:11.5,night:0.0,ifr:11.5,xc:11.5,ldDay:1,to:0,flightNum:"YP601",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2123,date:"2024-06-08",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.5,total:13.5,night:10.0,ifr:13.5,xc:13.5,ldDay:0,to:1,flightNum:"YP602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2124,date:"2024-06-15",dep:"RKSI",arr:"VTBS",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:5.5,total:5.5,night:0.0,ifr:5.5,xc:5.5,ldDay:1,to:0,flightNum:"YP1651",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2125,date:"2024-06-17",dep:"VTBS",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:5.5,total:5.5,night:0.0,ifr:5.5,xc:5.5,ldDay:0,to:1,flightNum:"YP1652",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2126,date:"2024-07-01",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:11.5,total:11.5,night:8.0,ifr:11.5,xc:11.5,ldDay:1,to:0,flightNum:"YP601",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2127,date:"2024-07-03",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:0,sic:13.5,total:13.5,night:10.0,ifr:13.5,xc:13.5,ldDay:0,to:1,flightNum:"YP602",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2130,date:"2024-07-24",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:11.07,total:11.07,night:4.0,ifr:11.07,xc:11.07,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2131,date:"2024-07-29",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:11.07,total:11.07,night:7.0,ifr:11.07,xc:11.07,ldDay:1,to:0,flightNum:"YP2211",crew:"4",remarks:"제2기장",captain:"위종석",fo:""},
  {id:2132,date:"2024-08-01",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:12.0,total:12.0,night:2.0,ifr:12.0,xc:12.0,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2133,date:"2024-08-14",dep:"RKSI",arr:"KEWR",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:14.0,total:14.0,night:0.0,ifr:14.0,xc:14.0,ldDay:1,to:0,flightNum:"YP2401",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2134,date:"2024-08-16",dep:"KEWR",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:14.0,total:14.0,night:0.0,ifr:14.0,xc:14.0,ldDay:0,to:1,flightNum:"YP2402",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2135,date:"2024-09-14",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:12.0,total:12.0,night:1.0,ifr:12.0,xc:12.0,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2136,date:"2024-09-18",dep:"RKSI",arr:"KEWR",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8346",acType:"B787-9",pic:0,sic:14.0,total:14.0,night:0.0,ifr:14.0,xc:14.0,ldDay:1,to:0,flightNum:"YP2401",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2140,date:"2024-10-03",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:10.72,total:10.72,night:0.0,ifr:10.72,xc:10.72,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2141,date:"2024-10-05",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.18,total:12.18,night:0.0,ifr:12.18,xc:12.18,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2142,date:"2024-10-13",dep:"RKSI",arr:"KEWR",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:12.77,total:12.77,night:9.6,ifr:12.77,xc:12.77,ldDay:1,to:0,flightNum:"YP2401",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2143,date:"2024-10-14",dep:"KEWR",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8512",acType:"B787-9",pic:0,sic:14.17,total:14.17,night:0.0,ifr:14.17,xc:14.17,ldDay:0,to:1,flightNum:"YP2402",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2144,date:"2024-10-17",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:12.77,total:12.77,night:7.6,ifr:12.77,xc:12.77,ldDay:1,to:0,flightNum:"YP2211",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2145,date:"2024-10-21",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:12.18,total:12.18,night:0.0,ifr:12.18,xc:12.18,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2146,date:"2024-10-22",dep:"RKSI",arr:"RJAA",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:2.5,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:1,to:0,flightNum:"YP321",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2147,date:"2024-11-01",dep:"RJAA",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:2.5,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:0,to:1,flightNum:"YP322",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2148,date:"2024-11-04",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:11.5,total:11.5,night:0.0,ifr:11.5,xc:11.5,ldDay:1,to:0,flightNum:"YP101",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2149,date:"2024-11-05",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:13.5,total:13.5,night:0.0,ifr:13.5,xc:13.5,ldDay:0,to:1,flightNum:"YP102",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2150,date:"2024-11-21",dep:"RKSI",arr:"KEWR",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:14.55,total:14.55,night:2.0,ifr:14.55,xc:14.55,ldDay:1,to:0,flightNum:"YP2401",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2155,date:"2024-12-20",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8513",acType:"B787-9",pic:0,sic:10.13,total:10.13,night:9.13,ifr:10.13,xc:10.13,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"",captain:"위종석",fo:""},
  {id:2160,date:"2025-01-15",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:10.58,sic:0,total:10.58,night:0.0,ifr:10.58,xc:10.58,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2161,date:"2025-01-16",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:12.02,sic:0,total:12.02,night:7.0,ifr:12.02,xc:12.02,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2162,date:"2025-01-26",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:12.02,sic:0,total:12.02,night:7.42,ifr:12.02,xc:12.02,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2163,date:"2025-02-05",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2164,date:"2025-02-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8916",acType:"B787-9",pic:10.98,sic:0,total:10.98,night:0.0,ifr:10.98,xc:10.98,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2165,date:"2025-02-24",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:12.48,sic:0,total:12.48,night:0.0,ifr:12.48,xc:12.48,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2166,date:"2025-02-27",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2167,date:"2025-03-21",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:12.0,sic:0,total:12.0,night:7.48,ifr:12.0,xc:12.0,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2168,date:"2025-03-22",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:11.73,sic:0,total:11.73,night:0.0,ifr:11.73,xc:11.73,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2169,date:"2025-04-22",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:12.0,sic:0,total:12.0,night:0.0,ifr:12.0,xc:12.0,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2170,date:"2025-04-25",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8701",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2171,date:"2025-04-28",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8916",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:12.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2175,date:"2025-03-11",dep:"RKSI",arr:"VVDN",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:9.07,sic:0,total:9.07,night:2.5,ifr:9.07,xc:9.07,ldDay:1,to:1,flightNum:"YP2631",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2176,date:"2025-03-12",dep:"VVDN",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:4.02,sic:0,total:4.02,night:2.67,ifr:4.02,xc:4.02,ldDay:0,to:1,flightNum:"YP2632",crew:"4",remarks:"기장 ICN-DAD 초항",captain:"위종석",fo:""},
  {id:2177,date:"2025-04-05",dep:"RKSI",arr:"VVDN",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:4.0,sic:0,total:4.0,night:0.0,ifr:4.0,xc:4.0,ldDay:1,to:1,flightNum:"YP2631",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2178,date:"2025-04-07",dep:"VVDN",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:4.0,sic:0,total:4.0,night:0.0,ifr:4.0,xc:4.0,ldDay:0,to:1,flightNum:"YP2632",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2179,date:"2025-05-01",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:11.5,sic:0,total:11.5,night:4.75,ifr:11.5,xc:11.5,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2180,date:"2025-05-05",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:12.5,sic:0,total:12.5,night:0.0,ifr:12.5,xc:12.5,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2181,date:"2025-05-10",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8510",acType:"B787-9",pic:11.45,sic:0,total:11.45,night:0.0,ifr:11.45,xc:11.45,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2185,date:"2025-07-20",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:11.02,sic:0,total:11.02,night:1.0,ifr:11.02,xc:11.02,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"교관비행",captain:"위종석",fo:""},
  {id:2186,date:"2025-07-23",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:12.37,sic:0,total:12.37,night:0.0,ifr:12.37,xc:12.37,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2187,date:"2025-08-09",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2188,date:"2025-08-12",dep:"KLAX",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:12.5,sic:0,total:12.5,night:0.0,ifr:12.5,xc:12.5,ldDay:0,to:1,flightNum:"YP2102",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2189,date:"2025-09-15",dep:"PHNL",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:8.0,sic:0,total:8.0,night:5.0,ifr:8.0,xc:8.0,ldDay:0,to:1,flightNum:"YP2122",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2190,date:"2025-10-01",dep:"RKSI",arr:"PHNL",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8389",acType:"B787-9",pic:8.0,sic:0,total:8.0,night:0.0,ifr:8.0,xc:8.0,ldDay:1,to:1,flightNum:"YP2121",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2193,date:"2025-10-02",dep:"PHNL",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8393",acType:"B787-9",pic:9.13,sic:0,total:9.13,night:5.0,ifr:9.13,xc:9.13,ldDay:0,to:1,flightNum:"YP2122",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2194,date:"2025-10-10",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8403",acType:"B787-9",pic:9.13,sic:0,total:9.13,night:5.0,ifr:9.13,xc:9.13,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2195,date:"2025-10-17",dep:"RKSI",arr:"PHNL",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8403",acType:"B787-9",pic:10.45,sic:0,total:10.45,night:5.67,ifr:10.45,xc:10.45,ldDay:1,to:1,flightNum:"YP2121",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2196,date:"2025-10-25",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8403",acType:"B787-9",pic:12.0,sic:0,total:12.0,night:0.0,ifr:12.0,xc:12.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2197,date:"2025-11-09",dep:"RKSI",arr:"RJAA",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8403",acType:"B787-9",pic:2.5,sic:0,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:1,to:1,flightNum:"YP2321",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2198,date:"2025-11-11",dep:"RJAA",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8403",acType:"B787-9",pic:2.5,sic:0,total:2.5,night:0.0,ifr:2.5,xc:2.5,ldDay:0,to:1,flightNum:"YP2322",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2199,date:"2025-12-05",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8302",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2200,date:"2025-12-10",dep:"RKSI",arr:"KSFO",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8302",acType:"B787-9",pic:10.52,sic:0,total:10.52,night:0.0,ifr:10.52,xc:10.52,ldDay:1,to:1,flightNum:"YP2211",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2201,date:"2025-12-13",dep:"KSFO",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8302",acType:"B787-9",pic:11.73,sic:0,total:11.73,night:0.0,ifr:11.73,xc:11.73,ldDay:0,to:1,flightNum:"YP2212",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2202,date:"2025-12-15",dep:"RKSI",arr:"VVDN",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8302",acType:"B787-9",pic:4.0,sic:0,total:4.0,night:0.0,ifr:4.0,xc:4.0,ldDay:1,to:1,flightNum:"YP2631",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2203,date:"2025-12-16",dep:"VVDN",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8302",acType:"B787-9",pic:4.0,sic:0,total:4.0,night:0.0,ifr:4.0,xc:4.0,ldDay:0,to:1,flightNum:"YP2632",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2210,date:"2026-01-10",dep:"RKSI",arr:"VVDN",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8102",acType:"B787-9",pic:10.13,sic:0,total:10.13,night:0.0,ifr:10.13,xc:10.13,ldDay:1,to:1,flightNum:"YP2631",crew:"4",remarks:"기장 FARO도착",captain:"위종석",fo:""},
  {id:2211,date:"2026-01-12",dep:"VVDN",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8802",acType:"B787-9",pic:4.0,sic:0,total:4.0,night:0.0,ifr:4.0,xc:4.0,ldDay:0,to:1,flightNum:"YP2632",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2212,date:"2026-01-14",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8802",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:4.63,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장 초항 A/C",captain:"위종석",fo:""},
  {id:2213,date:"2026-01-28",dep:"PHNL",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:8.5,sic:0,total:8.5,night:0.0,ifr:8.5,xc:8.5,ldDay:0,to:1,flightNum:"YP2122",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2214,date:"2026-01-30",dep:"RKSI",arr:"PHNL",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8383",acType:"B787-9",pic:9.0,sic:0,total:9.0,night:5.47,ifr:9.0,xc:9.0,ldDay:1,to:1,flightNum:"YP2121",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2215,date:"2026-02-10",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8391",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2216,date:"2026-02-11",dep:"PHNL",arr:"RKSI",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8391",acType:"B787-9",pic:8.0,sic:0,total:8.0,night:0.0,ifr:8.0,xc:8.0,ldDay:0,to:1,flightNum:"YP2122",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2217,date:"2026-02-21",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8767",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:6.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장",captain:"위종석",fo:""},
  {id:2218,date:"2026-02-25",dep:"RKSI",arr:"KLAX",rampOutUtc:"",rampInUtc:"",depTime:"",arrTime:"",aircraft:"HL8391",acType:"B787-9",pic:11.0,sic:0,total:11.0,night:0.0,ifr:11.0,xc:11.0,ldDay:1,to:1,flightNum:"YP2101",crew:"4",remarks:"기장 아이슬랜딩 경험",captain:"위종석",fo:""},
];

// ─── Theme ────────────────────────────────────────────────────────────────────
const useTheme=()=>{const[dark,setDark]=useState(()=>window.matchMedia("(prefers-color-scheme:dark)").matches);useEffect(()=>{const mq=window.matchMedia("(prefers-color-scheme:dark)");const h=e=>setDark(e.matches);mq.addEventListener("change",h);return()=>mq.removeEventListener("change",h);},[]);return dark;};

const T_DARK={
  bg:"#111318",card:"#1a1e28",card2:"#202430",border:"#2a3346",
  text:"#e2e8f4",muted:"#4a5a78",sub:"#8896b4",
  accent:"#4d9fff",blue:"#64b5ff",green:"#34c85a",red:"#ff4a3d",
  orange:"#ff9500",purple:"#c265ff",teal:"#30c0e0",
  ok:"rgba(52,200,90,0.12)",okB:"#34c85a",
  warn:"rgba(255,74,61,0.12)",warnB:"#ff4a3d",
  caution:"rgba(255,149,0,0.12)",cautionB:"#ff9500",
  tab:"rgba(17,19,24,0.95)",sep:"#1e2436",
};
const T_LIGHT={
  bg:"#f0f2f7",card:"#ffffff",card2:"#f7f8fc",border:"#dde2ef",
  text:"#1a2035",muted:"#8a96b2",sub:"#5a6a8a",
  accent:"#1a6fd4",blue:"#2b82e8",green:"#18a84a",red:"#d93025",
  orange:"#c97a00",purple:"#7c3aed",teal:"#0e7890",
  ok:"rgba(24,168,74,0.08)",okB:"#18a84a",
  warn:"rgba(217,48,37,0.08)",warnB:"#d93025",
  caution:"rgba(201,122,0,0.1)",cautionB:"#c97a00",
  tab:"rgba(240,242,247,0.95)",sep:"#e8ecf4",
};

// ─── Shared components ────────────────────────────────────────────────────────
const iS=(T)=>({width:"100%",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10,color:T.text,padding:"11px 13px",fontSize:14,outline:"none",fontFamily:"system-ui",display:"block",WebkitAppearance:"none"});
const Lbl=({T,children,mt=12})=><div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:5,marginTop:mt}}>{children}</div>;

// ─── Calendar View ────────────────────────────────────────────────────────────
function CalendarView({T, flights, onSelect}) {
  const now = new Date();
  const [yr, setYr] = useState(now.getFullYear());
  const [mo, setMo] = useState(now.getMonth());

  const firstDay = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo+1, 0).getDate();
  const todayStr = today();

  // build flight map for this month
  const flightMap = {};
  flights.forEach(f => {
    const d = new Date(f.date);
    if (d.getFullYear()===yr && d.getMonth()===mo) {
      const key = f.date;
      if (!flightMap[key]) flightMap[key] = [];
      flightMap[key].push(f);
    }
  });

  const months = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
  const days = ["일","월","화","수","목","금","토"];

  const prev = () => { if(mo===0){setYr(y=>y-1);setMo(11);}else setMo(m=>m-1); };
  const next = () => { if(mo===11){setYr(y=>y+1);setMo(0);}else setMo(m=>m+1); };

  const cells = [];
  for(let i=0;i<firstDay;i++) cells.push(null);
  for(let d=1;d<=daysInMonth;d++) cells.push(d);

  return (
    <div style={{padding:"0 0 12px"}}>
      {/* Month nav */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 18px 12px"}}>
        <button onClick={prev} style={{background:"none",border:"none",color:T.muted,fontSize:20,cursor:"pointer",padding:"4px 10px"}}>‹</button>
        <div style={{fontFamily:"'SF Pro Display',system-ui",fontSize:17,fontWeight:700,color:T.text,letterSpacing:0.5}}>
          {yr}년 {months[mo]}
        </div>
        <button onClick={next} style={{background:"none",border:"none",color:T.muted,fontSize:20,cursor:"pointer",padding:"4px 10px"}}>›</button>
      </div>

      {/* Day headers */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"0 12px 6px",gap:2}}>
        {days.map((d,i)=>(
          <div key={d} style={{textAlign:"center",fontSize:10,fontWeight:700,color:i===0?"#ff4a3d":i===6?T.blue:T.muted,letterSpacing:0.5,padding:"4px 0"}}>{d}</div>
        ))}
      </div>

      {/* Calendar grid */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"0 12px",gap:3}}>
        {cells.map((d,i) => {
          if(!d) return <div key={`e${i}`}/>;
          const dateStr = `${yr}-${String(mo+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
          const fs = flightMap[dateStr] || [];
          const isToday = dateStr === todayStr;
          const isSun = (i%7)===0;
          const hasFlight = fs.length > 0;
          const totalHrs = fs.reduce((a,f)=>a+(f.total||0),0);

          return (
            <div key={d} onClick={()=>hasFlight&&onSelect(fs)}
              style={{
                minHeight:48, borderRadius:10, padding:"5px 4px",
                background: isToday ? T.accent : hasFlight ? `${T.accent}18` : "transparent",
                border: `1px solid ${isToday ? T.accent : hasFlight ? `${T.accent}40` : "transparent"}`,
                cursor: hasFlight ? "pointer" : "default",
                display:"flex",flexDirection:"column",alignItems:"center",
              }}>
              <div style={{
                fontSize:13,fontWeight:isToday?700:hasFlight?600:400,
                color:isToday?"#fff":isSun?"#ff4a3d":hasFlight?T.accent:T.sub,
                lineHeight:1,marginBottom:2,
              }}>{d}</div>
              {hasFlight && (
                <>
                  <div style={{width:5,height:5,borderRadius:"50%",background:isToday?"rgba(255,255,255,0.8)":T.accent,margin:"1px 0"}}/>
                  <div style={{fontSize:8,color:isToday?"rgba(255,255,255,0.9)":T.accent,fontWeight:700,lineHeight:1}}>{fmtH(totalHrs)}</div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Monthly summary */}
      {(() => {
        const monthFlights = flights.filter(f=>{const d=new Date(f.date);return d.getFullYear()===yr&&d.getMonth()===mo;});
        if(monthFlights.length===0) return null;
        const mTotal = monthFlights.reduce((a,f)=>a+(f.total||0),0);
        const mNight = monthFlights.reduce((a,f)=>a+(f.night||0),0);
        return (
          <div style={{margin:"12px 12px 0",background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
            {[{l:"비행편수",v:`${monthFlights.length}편`},{l:"총 시간",v:fmtH(mTotal)},{l:"야간",v:fmtH(mNight)}].map(s=>(
              <div key={s.l}>
                <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{s.l}</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:700,color:T.accent}}>{s.v}</div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────
function DashboardTab({T, flights, profile, C, onMedical, onGotoLogs}) {
  const totals = flights.reduce((a,f)=>({t:a.t+(f.total||0),n:a.n+(f.night||0),p:a.p+(f.pic||0),cnt:a.cnt+1}),{t:0,n:0,p:0,cnt:0});
  const medDays = profile.medical ? Math.ceil((new Date(profile.medical)-new Date())/86400000) : null;
  const medWarn = medDays!==null && medDays < 60;
  const medExp = medDays!==null && medDays <= 0;
  const [editMed, setEditMed] = useState(false);
  const allOk = C.toOk && C.ldOk;

  const StatCard=({label,value,sub,color,wide=false})=>(
    <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",gridColumn:wide?"1/-1":"auto"}}>
      <div style={{fontSize:9,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:6,fontWeight:600}}>{label}</div>
      <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:wide?28:22,fontWeight:700,color:color||T.accent,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:T.muted,marginTop:4}}>{sub}</div>}
    </div>
  );

  return (
    <div style={{padding:"14px 14px 10px"}} className="fu">

      {/* Pilot identity strip */}
      <div style={{background:`linear-gradient(135deg,${T.card} 0%,${T.card2} 100%)`,border:`1px solid ${T.border}`,borderRadius:16,padding:"16px 18px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:4,fontWeight:600}}>AIRLINE TRANSPORT PILOT</div>
          <div style={{fontSize:20,fontWeight:700,color:T.text,letterSpacing:0.3}}>{profile.name}</div>
          <div style={{fontSize:11,color:T.muted,marginTop:3}}>{profile.airline} · {profile.empNo} · {profile.acTypes}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:32,fontWeight:700,color:T.accent,lineHeight:1}}>{fmtH(totals.t)}</div>
          <div style={{fontSize:9,color:T.muted,letterSpacing:2,textTransform:"uppercase",marginTop:3}}>TOTAL TIME</div>
        </div>
      </div>

      {/* Stat grid */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        <StatCard label="PIC Time" value={fmtH(totals.p)} sub="기장 비행시간"/>
        <StatCard label="Night Time" value={fmtH(totals.n)} color={T.purple} sub="야간 비행시간"/>
        <StatCard label="Total Flights" value={`${totals.cnt}편`} color={T.teal} sub={`${flights[0]?.date||"—"} ~ ${flights[flights.length-1]?.date||"—"}`} wide/>
      </div>

      {/* Currency status */}
      <button onClick={onGotoLogs} style={{all:"unset",display:"block",width:"100%",boxSizing:"border-box",marginBottom:12}}>
        <div style={{background:allOk?T.ok:T.warn,border:`1px solid ${allOk?T.okB:T.warnB}`,borderRadius:14,padding:"14px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600}}>90일 이착륙 통화</div>
            <div style={{fontSize:10,color:allOk?T.green:T.red,fontWeight:700}}>{allOk?"✓ 충족":"⚠ 확인 필요"}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {[{l:"이륙 (T/O)",v:C.to90,ok:C.toOk,exp:C.toExp,d:C.toD},{l:"착륙",v:C.ld90,ok:C.ldOk,exp:C.ldExp,d:C.ldD}].map(s=>(
              <div key={s.l} style={{background:T.card,borderRadius:10,padding:"10px 12px",border:`1px solid ${s.ok?T.okB+"40":T.warnB+"40"}`}}>
                <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
                <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                  <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:26,fontWeight:700,color:s.ok?T.green:T.red,lineHeight:1}}>{s.v}</span>
                  <span style={{fontSize:11,color:T.muted}}>/3</span>
                </div>
                {s.ok&&s.d!==null&&<div style={{fontSize:9,color:s.d<=30?T.orange:T.muted,marginTop:3,fontWeight:s.d<=30?700:400}}>D-{s.d}</div>}
                {!s.ok&&<div style={{fontSize:9,color:T.red,marginTop:3,fontWeight:700}}>미충족</div>}
              </div>
            ))}
          </div>
        </div>
      </button>

      {/* Hour limits */}
      <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
        <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:12}}>비행시간 한도</div>
        {[{l:"28일",h:C.hrs28,lim:120},{l:"90일",h:C.hrs90,lim:300},{l:"365일",h:C.hrs365,lim:1000}].map(r=>{
          const pct=Math.min(100,r.h/r.lim*100);
          const c=pct>=90?T.red:pct>=75?T.orange:T.accent;
          return (
            <div key={r.l} style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:T.sub,fontWeight:600}}>{r.l} 한도 {fmtH(r.lim)}</span>
                <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:12,fontWeight:700,color:c}}>{fmtH(r.h)}</span>
              </div>
              <div style={{height:5,background:T.sep,borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${pct}%`,background:c,borderRadius:3,transition:"width 1s ease"}}/>
              </div>
            </div>
          );
        })}
      </div>

      {/* Medical */}
      <div onClick={()=>!editMed&&setEditMed(true)}
        style={{background:medExp?T.warn:medWarn?T.caution:T.card,border:`1px solid ${medExp?T.warnB:medWarn?T.cautionB:T.border}`,borderRadius:14,padding:"14px 16px",cursor:editMed?"default":"pointer"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{flex:1}}>
            <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
              Medical Certificate
              {!editMed&&<span style={{fontSize:8,color:T.accent,background:`${T.accent}18`,borderRadius:3,padding:"1px 5px"}}>✎</span>}
            </div>
            {editMed ? (
              <div style={{display:"flex",gap:8,marginTop:4}}>
                <input type="date" defaultValue={profile.medical||""} autoFocus
                  onChange={e=>onMedical(e.target.value)}
                  style={{...iS(T),flex:1,border:`1.5px solid ${T.accent}`,fontSize:14}}/>
                <button onClick={e=>{e.stopPropagation();setEditMed(false);}}
                  style={{background:T.accent,border:"none",borderRadius:8,color:"#fff",padding:"0 14px",fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0}}>확인</button>
              </div>
            ) : (
              <div style={{fontSize:14,fontWeight:600,color:medExp?T.red:T.text}}>
                {profile.medical||<span style={{color:T.muted,fontStyle:"italic",fontSize:12}}>탭하여 날짜 입력</span>}
              </div>
            )}
          </div>
          {!editMed&&medDays!==null&&(
            <div style={{textAlign:"right",marginLeft:16,flexShrink:0}}>
              <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:28,fontWeight:700,color:medExp?T.red:medWarn?T.orange:T.green,lineHeight:1}}>{medExp?"만료":medDays}</div>
              <div style={{fontSize:9,color:T.muted,marginTop:2}}>{medExp?"EXPIRED":"DAYS LEFT"}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Logbook Tab (List + Calendar) ───────────────────────────────────────────
function LogbookTab({T, flights, onDetail, onAdd}) {
  const [view, setView] = useState("list"); // "list" | "cal"
  const [q, setQ] = useState("");
  const [calSel, setCalSel] = useState(null); // selected day flights
  const [asc, setAsc] = useState(false);

  const list = flights
    .filter(f=>!q||[f.dep,f.arr,f.flightNum,f.aircraft,f.remarks].some(v=>(v||"").toLowerCase().includes(q.toLowerCase())))
    .sort((a,b)=>asc?a.date.localeCompare(b.date):b.date.localeCompare(a.date));

  const totals = list.reduce((a,f)=>({t:a.t+(f.total||0),cnt:a.cnt+1}),{t:0,cnt:0});

  return (
    <div className="fu" style={{display:"flex",flexDirection:"column",height:"100%"}}>
      {/* Header bar */}
      <div style={{padding:"12px 14px 8px",position:"sticky",top:0,zIndex:10,background:T.bg}}>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <div style={{flex:1,position:"relative"}}>
            <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:T.muted,fontSize:13}}>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="편명·공항·기체 검색…"
              style={{...iS(T),paddingLeft:34,marginBottom:0,fontSize:13}}/>
          </div>
          <button onClick={()=>setAsc(!asc)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"0 13px",color:T.muted,cursor:"pointer",fontSize:15,flexShrink:0}}>{asc?"↑":"↓"}</button>
        </div>

        {/* View toggle */}
        <div style={{display:"flex",background:T.card2,borderRadius:10,padding:3,gap:2,border:`1px solid ${T.border}`}}>
          {[["list","📋 목록"],["cal","📅 달력"]].map(([v,l])=>(
            <button key={v} onClick={()=>setView(v)} style={{
              flex:1,padding:"7px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,
              background:view===v?T.accent:"transparent",color:view===v?"#fff":T.muted,transition:"all 0.2s",
            }}>{l}</button>
          ))}
        </div>
      </div>

      {view==="cal" ? (
        <>
          <CalendarView T={T} flights={flights} onSelect={fs=>setCalSel(fs)}/>
          {calSel&&(
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:200,display:"flex",alignItems:"flex-end"}} onClick={()=>setCalSel(null)}>
              <div style={{background:T.bg,borderRadius:"20px 20px 0 0",width:"100%",maxHeight:"60dvh",overflowY:"auto",padding:"16px"}} onClick={e=>e.stopPropagation()}>
                <div style={{width:36,height:4,background:T.border,borderRadius:2,margin:"0 auto 16px"}}/>
                {calSel.map(f=>(
                  <div key={f.id} onClick={()=>{onDetail(f);setCalSel(null);}}
                    style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",marginBottom:8,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:3}}>
                        {f.flightNum&&<span style={{fontSize:11,fontWeight:700,color:T.accent,background:`${T.accent}18`,borderRadius:4,padding:"1px 6px"}}>{f.flightNum}</span>}
                        <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:600,color:T.text}}>{f.dep} → {f.arr}</span>
                      </div>
                      <div style={{fontSize:11,color:T.muted}}>{f.aircraft} · {f.acType}</div>
                    </div>
                    <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:16,fontWeight:700,color:T.accent}}>{fmtH(f.total)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Summary strip */}
          <div style={{display:"flex",justifyContent:"space-between",padding:"0 16px 8px"}}>
            <span style={{fontSize:11,color:T.muted}}>{totals.cnt}편</span>
            <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,color:T.accent,fontWeight:700}}>{fmtH(totals.t)} total</span>
          </div>

          {/* Column headers */}
          <div style={{display:"grid",gridTemplateColumns:"58px 1fr 52px",padding:"4px 16px",gap:8}}>
            {["날짜","편명 / 노선","시간"].map((h,i)=>(
              <div key={h} style={{fontSize:9,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,textAlign:i===2?"right":"left"}}>{h}</div>
            ))}
          </div>
          <div style={{height:1,background:T.sep,margin:"4px 14px 0"}}/>

          {list.length===0&&<div style={{textAlign:"center",color:T.muted,padding:40,fontSize:13}}>검색 결과 없음</div>}
          {list.map((f,i)=>(
            <div key={f.id} onClick={()=>onDetail(f)}
              style={{display:"grid",gridTemplateColumns:"58px 1fr 52px",padding:"11px 16px",gap:8,borderBottom:`1px solid ${T.sep}`,cursor:"pointer",alignItems:"center",background:i%2===0?"transparent":T.card2+"80",transition:"opacity .1s"}}
              onTouchStart={e=>e.currentTarget.style.opacity="0.6"}
              onTouchEnd={e=>e.currentTarget.style.opacity="1"}>
              <div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,fontWeight:600,color:T.sub}}>{f.date.slice(5)}</div>
                <div style={{fontSize:9,color:T.muted,marginTop:1}}>{f.date.slice(0,4)}</div>
              </div>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
                  {f.flightNum&&<span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:10,fontWeight:700,color:T.accent,background:`${T.accent}18`,borderRadius:4,padding:"1px 5px"}}>{f.flightNum}</span>}
                  <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:600,color:T.text}}>{f.dep}→{f.arr}</span>
                </div>
                <div style={{fontSize:10,color:T.muted}}>{f.aircraft||"—"} · {f.acType}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:700,color:T.accent}}>{fmtH(f.total)}</div>
                {f.night>0&&<div style={{fontSize:9,color:T.purple}}>N {fmtH(f.night)}</div>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Add Flight (Simplified) ──────────────────────────────────────────────────
function AddTab({T, onSave, notify}) {
  const blank={date:today(),flightNum:"",dep:"",arr:"",rampOutUtc:"",rampInUtc:"",showUpUtc:"",depTime:"",arrTime:"",crew:"4",aircraft:"",acType:"B787-9",pic:"",sic:"",night:"",ifr:"",xc:"",ldDay:1,to:1,remarks:"",captain:"",fo:""};
  const [f,setF]=useState(blank);
  const [depQ,setDepQ]=useState(""),[arrQ,setArrQ]=useState("");
  const acTypes=["B737-700","B737-800","B737-900ER","B777-200ER","B777-300ER","B787-8","B787-9","B787-10","A320neo","A321neo","A330-200","A330-300","A330-900neo","A350-900","A350-1000","A380-800","기타"];
  const upd=(k,v)=>setF(p=>{
    const n={...p,[k]:v};
    if(k==="depTime"||k==="arrTime"){const t=decHrs(n.depTime,n.arrTime);if(t>0){if(!n.pic)n.pic=t.toFixed(2);if(!n.xc)n.xc=t.toFixed(2);if(!n.ifr)n.ifr=t.toFixed(2);}}
    return n;
  });
  const ramp=calcRamp(f);
  const save=()=>{
    if(!f.dep||!f.arr){notify("출발지/목적지 입력 필요",true);return;}
    const total=decHrs(f.depTime,f.arrTime)||parseFloat(f.pic)||f.total||0;
    onSave({...f,total,pic:parseFloat(f.pic)||0,sic:parseFloat(f.sic)||0,night:parseFloat(f.night)||0,ifr:parseFloat(f.ifr)||0,xc:parseFloat(f.xc)||total,ldDay:parseInt(f.ldDay)||0,to:parseInt(f.to)||0});
    setF(blank);
  };

  const IcaoSearch=({val,q,setQ,onSel,lbl})=>{
    const res=Object.entries(ICAO_DB).filter(([k,v])=>q.length>=1&&(k.startsWith(q.toUpperCase())||v.includes(q))).slice(0,4);
    return(
      <div>
        <Lbl T={T}>{lbl}</Lbl>
        <input value={val||q} onChange={e=>{setQ(e.target.value);onSel("");}} placeholder="ICAO 코드" style={iS(T)}/>
        {res.length>0&&(
          <div style={{background:T.card,border:`1px solid ${T.accent}40`,borderRadius:10,marginTop:2,overflow:"hidden",boxShadow:"0 4px 20px rgba(0,0,0,0.2)"}}>
            {res.map(([k,v])=>(
              <div key={k} onClick={()=>{onSel(k);setQ("");}} style={{padding:"9px 13px",cursor:"pointer",borderBottom:`1px solid ${T.sep}`,display:"flex",gap:10,alignItems:"center"}}>
                <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:12,fontWeight:700,color:T.accent,minWidth:40}}>{k}</span>
                <span style={{fontSize:12,color:T.sub}}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{padding:"14px 14px 30px",overflowY:"auto"}} className="fu">
      <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:14,letterSpacing:0.3}}>새 비행 기록</div>

      {/* Flight No + Date in one row */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div>
          <Lbl T={T} mt={0}>편명</Lbl>
          <input value={f.flightNum} onChange={e=>upd("flightNum",e.target.value.toUpperCase())}
            placeholder="KE101" style={{...iS(T),fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,letterSpacing:1}}/>
        </div>
        <div>
          <Lbl T={T} mt={0}>날짜</Lbl>
          <input type="date" value={f.date} onChange={e=>upd("date",e.target.value)} style={iS(T)}/>
        </div>
      </div>

      {/* Route */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <IcaoSearch val={f.dep} q={depQ} setQ={setDepQ} onSel={v=>upd("dep",v)} lbl="출발 (DEP)"/>
        <IcaoSearch val={f.arr} q={arrQ} setQ={setArrQ} onSel={v=>upd("arr",v)} lbl="도착 (ARR)"/>
      </div>

      {/* Times */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div><Lbl T={T}>OUT (UTC)</Lbl><input type="time" value={f.depTime} onChange={e=>upd("depTime",e.target.value)} style={iS(T)}/></div>
        <div><Lbl T={T}>IN (UTC)</Lbl><input type="time" value={f.arrTime} onChange={e=>upd("arrTime",e.target.value)} style={iS(T)}/></div>
      </div>

      {/* Aircraft */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div>
          <Lbl T={T}>기체번호</Lbl>
          <input value={f.aircraft} onChange={e=>upd("aircraft",e.target.value.toUpperCase())} placeholder="HL8387" style={iS(T)}/>
        </div>
        <div>
          <Lbl T={T}>기종</Lbl>
          <select value={f.acType} onChange={e=>upd("acType",e.target.value)} style={{...iS(T),color:T.text}}>
            {acTypes.map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* Crew */}
      <Lbl T={T}>승무 형태 (FDP 한도)</Lbl>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
        {[[2,"≤13h"],[3,"≤15h"],[4,"≤18h"]].map(([c,l])=>(
          <button key={c} onClick={()=>upd("crew",String(c))} style={{
            padding:"10px 4px",borderRadius:10,border:`1.5px solid ${f.crew==c?T.accent:T.border}`,
            background:f.crew==c?`${T.accent}18`:"transparent",color:f.crew==c?T.accent:T.muted,
            cursor:"pointer",fontSize:12,fontWeight:700,
          }}>{c}인 {l}</button>
        ))}
      </div>

      {/* Ramp */}
      <div style={{background:`${T.orange}10`,border:`1px solid ${T.orange}30`,borderRadius:14,padding:"14px",marginTop:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:10,color:T.orange,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>Ramp Time (UTC)</div>
          {ramp&&<div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:700,color:ramp.exceeds?T.red:T.green}}>{fmtHrs(ramp.hrs)} {ramp.exceeds?"⚠":"✓"}</div>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div><Lbl T={T} mt={0}>Ramp Out (UTC)</Lbl><input type="time" value={f.rampOutUtc} onChange={e=>upd("rampOutUtc",e.target.value)} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>Ramp In (UTC)</Lbl><input type="time" value={f.rampInUtc} onChange={e=>upd("rampInUtc",e.target.value)} style={iS(T)}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:8}}>
          <div>
            <Lbl T={T} mt={0}>Show Up (UTC) <span style={{fontSize:9,color:T.muted,fontWeight:400}}>— 야간수당 기준</span></Lbl>
            <input type="time" value={f.showUpUtc||""} onChange={e=>upd("showUpUtc",e.target.value)} style={iS(T)}/>
          </div>
          <div style={{display:"flex",alignItems:"center",paddingTop:22}}>
            {f.showUpUtc&&f.rampOutUtc&&(()=>{
              const su=timeToMins(f.showUpUtc),ro=timeToMins(f.rampOutUtc);
              if(su===null||ro===null)return null;
              let diff=ro-su;if(diff<0)diff+=1440;
              const h=Math.floor(diff/60),m=diff%60;
              return<div style={{fontSize:11,color:T.muted}}>Ramp까지 <span style={{color:T.accent,fontWeight:700}}>{h}:{String(m).padStart(2,"0")}</span></div>;
            })()}
          </div>
        </div>
        {ramp?.exceeds&&<div style={{marginTop:8,fontSize:11,color:T.red,fontWeight:700}}>⚠ FDP {fmtHrs(ramp.hrs)} — {FDP_LABEL[ramp.crew]} 한도 {fmtHrs(ramp.lim)} 초과</div>}
      </div>

      {/* Hours */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:12}}>
        {[["pic","PIC"],["night","야간"],["ifr","IFR"]].map(([k,l])=>(
          <div key={k}>
            <Lbl T={T} mt={0}>{l}</Lbl>
            <input type="number" step="0.01" value={f[k]} onChange={e=>upd(k,e.target.value)} placeholder="0.0" style={{...iS(T),textAlign:"center"}}/>
          </div>
        ))}
      </div>

      {/* T/O & Landing */}
      <div style={{background:`${T.green}10`,border:`1px solid ${T.green}30`,borderRadius:14,padding:"14px",marginTop:12}}>
        <div style={{fontSize:10,color:T.green,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>이착륙 통화</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[["to","✈ 이륙"],["ldDay","🛬 착륙"]].map(([k,l])=>(
            <div key={k}>
              <div style={{fontSize:10,color:T.green,fontWeight:600,marginBottom:5,textAlign:"center"}}>{l}</div>
              <input type="number" min="0" value={f[k]} onChange={e=>upd(k,e.target.value)}
                style={{...iS(T),textAlign:"center",fontFamily:"'SF Mono','Courier New',monospace",fontSize:24,fontWeight:700,color:T.green,border:`1px solid ${T.green}40`,padding:"12px"}}/>
            </div>
          ))}
        </div>
      </div>

      <Lbl T={T}>비고 (Remarks)</Lbl>
      <textarea value={f.remarks} onChange={e=>upd("remarks",e.target.value)} rows={2}
        placeholder="특이사항…" style={{...iS(T),resize:"none",lineHeight:1.6}}/>

      <button onClick={save} style={{
        width:"100%",marginTop:14,background:`linear-gradient(135deg,${T.accent},${T.blue})`,
        border:"none",borderRadius:14,color:"#fff",padding:"15px",fontSize:15,fontWeight:700,
        cursor:"pointer",letterSpacing:0.5,boxShadow:`0 4px 20px ${T.accent}30`,
      }}>✈ 저장</button>
    </div>
  );
}

// ─── Stats Tab ────────────────────────────────────────────────────────────────
function StatsTab({T, flights, setFlights, profile, setProfile, notify}) {
  const hourlyRate=profile.hourlyRate||"";
  const flightRate=profile.flightRate||"";
  const hr=parseFloat(hourlyRate)||0;
  const fr=parseFloat(flightRate)||0;
  const hasRates=hr>0||fr>0;

  const [activeSection,setActiveSection]=useState("totals"); // totals | actype | pay | monthly
  const [batchOpen,setBatchOpen]=useState(false);

  const allMonths=[...new Set(flights.map(f=>f.date.slice(0,7)))].sort((a,b)=>b.localeCompare(a));
  const [selM, setSelM]=useState(allMonths[0]||today().slice(0,7));

  const monthFlights=flights.filter(f=>f.date.startsWith(selM)).sort((a,b)=>a.date.localeCompare(b.date));
  const mTotal=monthFlights.reduce((a,f)=>({t:a.t+(f.total||0),n:a.n+(f.night||0),p:a.p+(f.pic||0),cnt:a.cnt+1}),{t:0,n:0,p:0,cnt:0});

  // ── 전체 누계 집계 ─────────────────────────────────────────────────────────
  const grandTotal=flights.reduce((a,f)=>({
    total:a.total+(f.total||0),
    pic:a.pic+(f.pic||0),
    sic:a.sic+(f.sic||0),
    night:a.night+(f.night||0),
    ifr:a.ifr+(f.ifr||0),
    to:a.to+(f.to||0),
    ld:a.ld+(f.ldDay||0),
    cnt:a.cnt+1,
  }),{total:0,pic:0,sic:0,night:0,ifr:0,to:0,ld:0,cnt:0});

  // ── 기종별 집계 ────────────────────────────────────────────────────────────
  const acTypeMap={};
  flights.forEach(f=>{
    const ac=f.acType||f.aircraft?.slice(0,4)||"Unknown";
    if(!acTypeMap[ac])acTypeMap[ac]={type:ac,total:0,pic:0,sic:0,night:0,ifr:0,to:0,ld:0,cnt:0};
    acTypeMap[ac].total+=f.total||0;
    acTypeMap[ac].pic+=f.pic||0;
    acTypeMap[ac].sic+=f.sic||0;
    acTypeMap[ac].night+=f.night||0;
    acTypeMap[ac].ifr+=f.ifr||0;
    acTypeMap[ac].to+=f.to||0;
    acTypeMap[ac].ld+=f.ldDay||0;
    acTypeMap[ac].cnt+=1;
  });
  const acTypes=Object.values(acTypeMap).sort((a,b)=>b.total-a.total);

  // Pay calc — new multi-allowance
  const pays=monthFlights.map(f=>calcPay(f,hourlyRate,flightRate)).filter(Boolean);
  const mPayBase=pays.reduce((a,p)=>({
    flightBase:a.flightBase+p.flightBase,
    overtime:a.overtime+p.overtime,
    threePBonus:a.threePBonus+p.threePBonus,
    nightBonus:a.nightBonus+p.nightBonus,
    total:a.total+p.total,
    flightHrs:a.flightHrs+p.flightHrs,
    nightHrs:a.nightHrs+p.nightHrs,
  }),{flightBase:0,overtime:0,threePBonus:0,nightBonus:0,total:0,flightHrs:0,nightHrs:0});
  const {excessPay,bands:excessBands}=calcExcessFlightPay(mPayBase.flightHrs,flightRate);
  const mPay={...mPayBase,excessPay,excessBands,total:mPayBase.total+excessPay};

  // By-year accumulation for chart
  const yearlyMap={};
  flights.forEach(f=>{const y=f.date.slice(0,4);yearlyMap[y]=(yearlyMap[y]||0)+(f.total||0);});
  const years=Object.entries(yearlyMap).sort((a,b)=>a[0].localeCompare(b[0]));
  const maxY=Math.max(...years.map(([,v])=>v),1);

  // ── Section nav tabs ────────────────────────────────────────────────────────
  const sections=[{k:"totals",l:"누계"},{k:"actype",l:"기종별"},{k:"pay",l:"수당"},{k:"monthly",l:"월별"}];

  return (
    <div style={{padding:"14px 14px 30px",overflowY:"auto"}} className="fu">

      {/* Batch update button */}
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
        <button onClick={()=>setBatchOpen(true)} style={{
          padding:"7px 14px",borderRadius:10,fontSize:11,fontWeight:700,cursor:"pointer",
          background:`${T.accent}18`,border:`1.5px solid ${T.accent}40`,color:T.accent,
          display:"flex",alignItems:"center",gap:5,
        }}>✏️ 일괄 업데이트</button>
      </div>

      {/* Section nav */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:14}}>
        {sections.map(s=>(
          <button key={s.k} onClick={()=>setActiveSection(s.k)} style={{
            padding:"8px 4px",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",
            border:`1.5px solid ${activeSection===s.k?T.accent:T.border}`,
            background:activeSection===s.k?`${T.accent}18`:"transparent",
            color:activeSection===s.k?T.accent:T.muted,
          }}>{s.l}</button>
        ))}
      </div>

      {/* ── 누계 섹션 ──────────────────────────────────────────────────────── */}
      {activeSection==="totals"&&(
        <>
          {/* Grand total hero */}
          <div style={{background:`linear-gradient(135deg,${T.accent}18,${T.blue}10)`,border:`1px solid ${T.accent}30`,borderRadius:14,padding:"16px",marginBottom:12}}>
            <div style={{fontSize:9,color:T.accent,letterSpacing:2,textTransform:"uppercase",fontWeight:700,marginBottom:8}}>전체 누계 — {grandTotal.cnt}편</div>
            <div style={{display:"flex",justifyContent:"center",alignItems:"baseline",gap:6,marginBottom:14}}>
              <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:42,fontWeight:700,color:T.accent,lineHeight:1}}>{fmtH(grandTotal.total)}</span>
              <span style={{fontSize:12,color:T.muted}}>TOTAL</span>
            </div>
            {/* PIC / SIC bar */}
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:10,color:T.green,fontWeight:700}}>PIC {fmtH(grandTotal.pic)}</span>
                <span style={{fontSize:10,color:T.orange,fontWeight:700}}>SIC {fmtH(grandTotal.sic)}</span>
              </div>
              <div style={{height:8,borderRadius:4,background:T.sep,overflow:"hidden",display:"flex"}}>
                <div style={{width:`${grandTotal.total>0?grandTotal.pic/grandTotal.total*100:0}%`,background:T.green,transition:"width 0.5s ease"}}/>
                <div style={{width:`${grandTotal.total>0?grandTotal.sic/grandTotal.total*100:0}%`,background:T.orange,transition:"width 0.5s ease"}}/>
              </div>
            </div>
            {/* Stats grid */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              {[{l:"야간",v:fmtH(grandTotal.night),c:T.purple},{l:"IFR",v:fmtH(grandTotal.ifr),c:T.blue},{l:"이착륙",v:`${grandTotal.to}/${grandTotal.ld}`,c:T.text}].map(s=>(
                <div key={s.l} style={{background:T.card,borderRadius:10,padding:"10px 8px",textAlign:"center"}}>
                  <div style={{fontSize:8,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{s.l}</div>
                  <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Yearly bar chart */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
            <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:14}}>연도별 비행시간</div>
            <div style={{display:"flex",alignItems:"flex-end",gap:6,height:80}}>
              {years.map(([y,h])=>{
                const yFlights=flights.filter(f=>f.date.startsWith(y));
                const yPic=yFlights.reduce((a,f)=>a+(f.pic||0),0);
                const ySic=yFlights.reduce((a,f)=>a+(f.sic||0),0);
                const pctPic=h>0?yPic/h:0;
                const pctSic=h>0?ySic/h:0;
                const barH=(h/maxY)*60;
                return(
                  <div key={y} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                    <div style={{fontSize:8,color:T.accent,fontWeight:700}}>{fmtH(h)}</div>
                    <div style={{width:"100%",borderRadius:"3px 3px 0 0",height:`${barH}px`,minHeight:4,overflow:"hidden",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
                      <div style={{width:"100%",background:T.orange,height:`${pctSic*barH}px`}}/>
                      <div style={{width:"100%",background:T.green,height:`${pctPic*barH}px`}}/>
                    </div>
                    <div style={{fontSize:8,color:T.muted}}>{y.slice(2)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{display:"flex",gap:12,justifyContent:"center",marginTop:8}}>
              <span style={{fontSize:9,color:T.green}}>● PIC</span>
              <span style={{fontSize:9,color:T.orange}}>● SIC</span>
            </div>
          </div>
        </>
      )}

      {/* ── 기종별 섹션 ───────────────────────────────────────────────────── */}
      {activeSection==="actype"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {acTypes.map(ac=>{
            const picPct=ac.total>0?ac.pic/ac.total:0;
            const sicPct=ac.total>0?ac.sic/ac.total:0;
            return(
              <div key={ac.type} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px"}}>
                {/* Header */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                  <div>
                    <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:16,fontWeight:700,color:T.text,letterSpacing:1}}>{ac.type}</div>
                    <div style={{fontSize:10,color:T.muted,marginTop:2}}>{ac.cnt}편 운항</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:20,fontWeight:700,color:T.accent}}>{fmtH(ac.total)}</div>
                    <div style={{fontSize:9,color:T.muted}}>TOTAL</div>
                  </div>
                </div>
                {/* PIC/SIC stacked bar */}
                <div style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <div style={{fontSize:10,fontWeight:600}}>
                      <span style={{color:T.green}}>PIC </span>
                      <span style={{fontFamily:"'SF Mono','Courier New',monospace",color:T.green,fontSize:12}}>{fmtH(ac.pic)}</span>
                    </div>
                    <div style={{fontSize:10,fontWeight:600}}>
                      <span style={{color:T.orange}}>SIC </span>
                      <span style={{fontFamily:"'SF Mono','Courier New',monospace",color:T.orange,fontSize:12}}>{fmtH(ac.sic)}</span>
                    </div>
                  </div>
                  <div style={{height:10,borderRadius:5,background:T.sep,overflow:"hidden",display:"flex"}}>
                    <div style={{width:`${picPct*100}%`,background:`linear-gradient(90deg,${T.green},${T.green}cc)`,borderRadius:"5px 0 0 5px",transition:"width 0.5s"}}/>
                    <div style={{width:`${sicPct*100}%`,background:`linear-gradient(90deg,${T.orange}cc,${T.orange})`,transition:"width 0.5s"}}/>
                  </div>
                </div>
                {/* Sub stats */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6}}>
                  {[{l:"야간",v:fmtH(ac.night),c:T.purple},{l:"IFR",v:fmtH(ac.ifr),c:T.blue},{l:"이륙",v:ac.to,c:T.text},{l:"착륙",v:ac.ld,c:T.text}].map(s=>(
                    <div key={s.l} style={{background:`${T.sep}60`,borderRadius:7,padding:"7px 6px",textAlign:"center"}}>
                      <div style={{fontSize:8,color:T.muted,marginBottom:2}}>{s.l}</div>
                      <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,fontWeight:700,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {acTypes.length===0&&<div style={{textAlign:"center",color:T.muted,padding:24,fontSize:13}}>비행 기록이 없습니다</div>}
        </div>
      )}

      {/* ── 수당 섹션 ──────────────────────────────────────────────────────── */}
      {activeSection==="pay"&&(
        <>
          {/* Month selector */}
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12,WebkitOverflowScrolling:"touch"}}>
            {allMonths.map(m=>(
              <button key={m} onClick={()=>setSelM(m)} style={{
                flexShrink:0,padding:"6px 12px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",
                border:`1.5px solid ${selM===m?T.accent:T.border}`,
                background:selM===m?`${T.accent}18`:"transparent",
                color:selM===m?T.accent:T.muted,
                fontFamily:"'SF Mono','Courier New',monospace",
              }}>{m}</button>
            ))}
          </div>

          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
            <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:12}}>수당 단가 설정</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>통상시급 <span style={{fontWeight:400}}>(야간)</span></div>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <input type="number" value={hourlyRate} placeholder="예: 25000"
                    onChange={e=>setProfile(p=>({...p,hourlyRate:e.target.value}))}
                    style={{...iS(T),marginBottom:0,fontSize:13,textAlign:"right",fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,color:T.purple}}/>
                  <span style={{fontSize:10,color:T.muted,flexShrink:0}}>원/시</span>
                </div>
              </div>
              <div>
                <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>비행수당 <span style={{fontWeight:400}}>(연장·3P)</span></div>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <input type="number" value={flightRate} placeholder="예: 15000"
                    onChange={e=>setProfile(p=>({...p,flightRate:e.target.value}))}
                    style={{...iS(T),marginBottom:0,fontSize:13,textAlign:"right",fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,color:T.orange}}/>
                  <span style={{fontSize:10,color:T.muted,flexShrink:0}}>원/시</span>
                </div>
              </div>
            </div>
            <div style={{background:`${T.sep}80`,borderRadius:8,padding:"8px 10px",fontSize:10,color:T.muted,lineHeight:1.6}}>
              <div>① <span style={{color:T.orange,fontWeight:700}}>비행수당</span> — Ramp시간 × 비행수당 + ×0.5 연장</div>
              <div>② <span style={{color:T.green,fontWeight:700}}>3P수당</span> — 3인 승무 × 비행수당 × 0.25</div>
              <div>③ <span style={{color:T.purple,fontWeight:700}}>야간수당</span> — Show Up~Ramp In+30분 KST 22~06시 × 통상시급 × 0.5</div>
              <div>④ <span style={{color:"#FF6B35",fontWeight:700}}>초과비행수당</span> — 월 70h 초과시 구간가산 (70~75h +10% / 76~85h +25% / 86~95h +50% / 95h초과 +80%)</div>
            </div>
          </div>

          {hasRates&&pays.length>0 ? (
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"14px 16px",marginBottom:12}}>
              <div style={{background:`linear-gradient(135deg,${T.accent}18,${T.blue}10)`,borderRadius:10,padding:"12px 14px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center",border:`1px solid ${T.accent}30`}}>
                <div>
                  <div style={{fontSize:10,color:T.accent,fontWeight:600,marginBottom:2}}>{selM} 예상 수당 합계</div>
                  <div style={{fontSize:9,color:T.muted}}>{pays.length}편 계산 완료</div>
                </div>
                <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:22,fontWeight:700,color:T.accent}}>{fmtWon(mPay.total)}</span>
              </div>
              {[
                {l:"비행수당 (기본)", sub:`${fmtH(mPay.flightHrs)} × ${fr.toLocaleString()}원`, v:mPay.flightBase, c:T.orange, show:fr>0},
                {l:"연장수당 +50%",   sub:"비행시간 × 비행수당 × 0.5",                           v:mPay.overtime,   c:T.red,    show:fr>0},
                {l:"3P 승무수당 +25%",sub:"3인 승무편 비행시간 × 비행수당 × 0.25",               v:mPay.threePBonus,c:T.green,  show:fr>0&&mPay.threePBonus>0},
                {l:"야간수당 +50%",   sub:`야간근무 ${fmtH(mPay.nightHrs)} × 통상시급 × 0.5`,    v:mPay.nightBonus, c:T.purple, show:hr>0},
              ].filter(r=>r.show).map(r=>(
                <div key={r.l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${T.sep}`}}>
                  <div>
                    <div style={{fontSize:12,color:r.c,fontWeight:600}}>{r.l}</div>
                    <div style={{fontSize:9,color:T.muted,marginTop:1}}>{r.sub}</div>
                  </div>
                  <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:700,color:r.c}}>{fmtWon(r.v)}</span>
                </div>
              ))}
              {fr>0&&mPay.excessPay>0&&(
                <div style={{marginTop:4}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${T.sep}`}}>
                    <div>
                      <div style={{fontSize:12,color:"#FF6B35",fontWeight:600}}>초과비행수당</div>
                      <div style={{fontSize:9,color:T.muted,marginTop:1}}>월 {fmtH(mPay.flightHrs)} — 70h 초과 구간 가산</div>
                    </div>
                    <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:700,color:"#FF6B35"}}>{fmtWon(mPay.excessPay)}</span>
                  </div>
                  {mPay.excessBands.map(b=>(
                    <div key={b.label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 8px",background:`#FF6B3510`,borderRadius:6,marginTop:3}}>
                      <div style={{fontSize:10,color:"#FF6B35"}}>{b.label} — {fmtH(b.hrs)}</div>
                      <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:10,fontWeight:600,color:"#FF6B35"}}>{fmtWon(b.pay)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"24px",textAlign:"center",color:T.muted,fontSize:13}}>
              {hasRates ? "Ramp 시간 입력 시 자동 계산됩니다" : "수당 단가를 입력하세요"}
            </div>
          )}
        </>
      )}

      {/* ── 월별 섹션 ──────────────────────────────────────────────────────── */}
      {activeSection==="monthly"&&(
        <>
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12,WebkitOverflowScrolling:"touch"}}>
            {allMonths.map(m=>(
              <button key={m} onClick={()=>setSelM(m)} style={{
                flexShrink:0,padding:"6px 12px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",
                border:`1.5px solid ${selM===m?T.accent:T.border}`,
                background:selM===m?`${T.accent}18`:"transparent",
                color:selM===m?T.accent:T.muted,
                fontFamily:"'SF Mono','Courier New',monospace",
              }}>{m}</button>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
            {[{l:"비행편수",v:`${mTotal.cnt}편`},{l:"총 시간",v:fmtH(mTotal.t)},{l:"PIC",v:fmtH(mTotal.p)}].map(s=>(
              <div key={s.l} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px",textAlign:"center"}}>
                <div style={{fontSize:8,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:5}}>{s.l}</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:15,fontWeight:700,color:T.accent}}>{s.v}</div>
              </div>
            ))}
          </div>

          {monthFlights.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden"}}>
              <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,padding:"12px 14px 8px"}}>{selM} 비행 내역</div>
              {monthFlights.map((f)=>{
                const p=calcPay(f,hourlyRate,flightRate);
                const crew=parseInt(f.crew)||4;
                const isPic=(f.pic||0)>0;
                return(
                  <div key={f.id} style={{padding:"10px 14px",borderTop:`1px solid ${T.sep}`}}>
                    <div style={{display:"grid",gridTemplateColumns:"80px 1fr auto",alignItems:"center",gap:8}}>
                      <div>
                        <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:10,color:T.muted}}>{f.date.slice(5)}</div>
                        {f.flightNum&&<div style={{fontSize:9,color:T.accent,fontWeight:700,marginTop:1}}>{f.flightNum}</div>}
                        <div style={{display:"flex",gap:3,marginTop:2,flexWrap:"wrap"}}>
                          <span style={{fontSize:8,background:isPic?`${T.green}20`:`${T.orange}20`,color:isPic?T.green:T.orange,fontWeight:700,borderRadius:3,padding:"1px 4px"}}>{isPic?"PIC":"SIC"}</span>
                          {crew===3&&<span style={{fontSize:8,background:`${T.blue}20`,color:T.blue,fontWeight:700,borderRadius:3,padding:"1px 4px"}}>3P</span>}
                        </div>
                      </div>
                      <div>
                        <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:12,fontWeight:600,color:T.text}}>{f.dep}→{f.arr}</div>
                        <div style={{fontSize:10,color:T.muted}}>{fmtH(f.total)} · {isPic?`PIC ${fmtH(f.pic)}`:`SIC ${fmtH(f.sic)}`}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        {p?<div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,fontWeight:700,color:T.accent}}>{fmtWon(p.total)}</div>
                          :<div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,color:T.muted}}>—</div>}
                      </div>
                    </div>
                    {p&&(p.threePBonus>0||p.nightBonus>0)&&(
                      <div style={{marginTop:5,display:"flex",gap:8,flexWrap:"wrap"}}>
                        {p.threePBonus>0&&<span style={{fontSize:9,background:`${T.green}20`,color:T.green,fontWeight:700,borderRadius:4,padding:"2px 6px"}}>3P +{fmtWon(p.threePBonus)}</span>}
                        {p.nightBonus>0&&<span style={{fontSize:9,background:`${T.purple}20`,color:T.purple,fontWeight:700,borderRadius:4,padding:"2px 6px"}}>야간 +{fmtWon(p.nightBonus)}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── 일괄 업데이트 모달 ─────────────────────────────────────────────── */}
      {batchOpen&&<BatchUpdateModal T={T} flights={flights} setFlights={setFlights} onClose={()=>setBatchOpen(false)} notify={notify}/>}
    </div>
  );
}

// ─── Batch Update Modal ───────────────────────────────────────────────────────
function BatchUpdateModal({T, flights, setFlights, onClose, notify}) {
  // Filter state
  const [filterAc, setFilterAc]=useState("all");
  const [filterRole, setFilterRole]=useState("all"); // all | pic | sic
  const [filterYear, setFilterYear]=useState("all");
  const [selected, setSelected]=useState(new Set());
  const [editField, setEditField]=useState("acType");
  const [editValue, setEditValue]=useState("");
  const [step, setStep]=useState("select"); // select | confirm

  const acTypeOptions=["all",...[...new Set(flights.map(f=>f.acType||"Unknown"))].sort()];
  const yearOptions=["all",...[...new Set(flights.map(f=>f.date.slice(0,4)))].sort((a,b)=>b-a)];

  const filtered=flights.filter(f=>{
    if(filterAc!=="all"&&(f.acType||"Unknown")!==filterAc)return false;
    if(filterRole==="pic"&&!(f.pic>0))return false;
    if(filterRole==="sic"&&!(f.sic>0))return false;
    if(filterYear!=="all"&&!f.date.startsWith(filterYear))return false;
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date));

  const toggleAll=()=>{
    if(selected.size===filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(f=>f.id)));
  };
  const toggle=(id)=>{
    const s=new Set(selected);
    s.has(id)?s.delete(id):s.add(id);
    setSelected(s);
  };

  const editFields=[
    {k:"acType",l:"기종 (acType)"},
    {k:"aircraft",l:"기체 등록번호"},
    {k:"crew",l:"승무 구성 (2/3/4)"},
    {k:"pic",l:"PIC 시간 (소수)"},
    {k:"sic",l:"SIC 시간 (소수)"},
    {k:"total",l:"총 비행시간 (소수)"},
    {k:"night",l:"야간 시간 (소수)"},
    {k:"ifr",l:"IFR 시간 (소수)"},
    {k:"to",l:"이륙 횟수"},
    {k:"ldDay",l:"착륙 횟수"},
  ];

  const applyBatch=()=>{
    if(!editValue.trim()||selected.size===0)return;
    const numFields=["pic","sic","total","night","ifr","to","ldDay","crew"];
    const val=numFields.includes(editField)?parseFloat(editValue):editValue.trim();
    setFlights(prev=>prev.map(f=>selected.has(f.id)?{...f,[editField]:val}:f));
    notify(`✅ ${selected.size}편 업데이트 완료`);
    onClose();
  };

  return(
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:T.bg,zIndex:600,overflowY:"auto",animation:"slideUp 0.2s ease"}}>
      <div style={{padding:"52px 16px 30px"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div>
            <div style={{fontSize:18,fontWeight:700,color:T.text}}>일괄 업데이트</div>
            <div style={{fontSize:11,color:T.muted,marginTop:2}}>필터 → 선택 → 필드 수정 → 적용</div>
          </div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:T.muted,fontSize:22,cursor:"pointer",padding:"4px 8px"}}>✕</button>
        </div>

        {/* Step 1 — Filter & Select */}
        {step==="select"&&(
          <>
            {/* Filters */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",marginBottom:12}}>
              <div style={{fontSize:10,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:10}}>필터</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {/* AC Type */}
                <div>
                  <div style={{fontSize:9,color:T.muted,marginBottom:4}}>기종</div>
                  <select value={filterAc} onChange={e=>setFilterAc(e.target.value)}
                    style={{...iS(T),marginBottom:0,fontSize:11,padding:"6px 8px"}}>
                    {acTypeOptions.map(a=><option key={a} value={a}>{a==="all"?"전체":a}</option>)}
                  </select>
                </div>
                {/* Role */}
                <div>
                  <div style={{fontSize:9,color:T.muted,marginBottom:4}}>구분</div>
                  <select value={filterRole} onChange={e=>setFilterRole(e.target.value)}
                    style={{...iS(T),marginBottom:0,fontSize:11,padding:"6px 8px"}}>
                    <option value="all">전체</option>
                    <option value="pic">PIC</option>
                    <option value="sic">SIC</option>
                  </select>
                </div>
                {/* Year */}
                <div>
                  <div style={{fontSize:9,color:T.muted,marginBottom:4}}>연도</div>
                  <select value={filterYear} onChange={e=>setFilterYear(e.target.value)}
                    style={{...iS(T),marginBottom:0,fontSize:11,padding:"6px 8px"}}>
                    {yearOptions.map(y=><option key={y} value={y}>{y==="all"?"전체":y}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Select all bar */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:T.card,border:`1px solid ${T.border}`,borderRadius:10,marginBottom:8}}>
              <button onClick={toggleAll} style={{background:"transparent",border:"none",color:T.accent,fontSize:12,fontWeight:700,cursor:"pointer",padding:0}}>
                {selected.size===filtered.length&&filtered.length>0?"☑ 전체 해제":"☐ 전체 선택"} ({filtered.length}편)
              </button>
              <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,color:T.muted}}>{selected.size}편 선택됨</span>
            </div>

            {/* Flight list */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden",marginBottom:12,maxHeight:320,overflowY:"auto"}}>
              {filtered.length===0&&<div style={{padding:20,textAlign:"center",color:T.muted,fontSize:12}}>해당 조건의 비행 없음</div>}
              {filtered.map(f=>{
                const isPic=(f.pic||0)>0;
                const sel=selected.has(f.id);
                return(
                  <div key={f.id} onClick={()=>toggle(f.id)}
                    style={{display:"grid",gridTemplateColumns:"32px 1fr auto",padding:"9px 12px",borderTop:`1px solid ${T.sep}`,alignItems:"center",gap:8,cursor:"pointer",
                      background:sel?`${T.accent}0a`:"transparent",transition:"background 0.15s"}}>
                    <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${sel?T.accent:T.border}`,background:sel?T.accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      {sel&&<span style={{color:"#fff",fontSize:11,fontWeight:700}}>✓</span>}
                    </div>
                    <div>
                      <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,fontWeight:600,color:T.text}}>{f.date} · {f.dep}→{f.arr}</div>
                      <div style={{fontSize:10,color:T.muted,marginTop:1}}>
                        <span style={{color:isPic?T.green:T.orange,fontWeight:700}}>{isPic?"PIC":"SIC"}</span>
                        {" · "}{f.acType||f.aircraft} · {fmtH(f.total)}
                      </div>
                    </div>
                    <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:10,color:T.muted}}>{f.flightNum}</div>
                  </div>
                );
              })}
            </div>

            {/* Edit field selector */}
            {selected.size>0&&(
              <div style={{background:T.card,border:`1px solid ${T.accent}40`,borderRadius:12,padding:"12px 14px",marginBottom:12}}>
                <div style={{fontSize:10,color:T.accent,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:10}}>수정할 필드 — {selected.size}편 대상</div>
                <div style={{marginBottom:10}}>
                  <select value={editField} onChange={e=>setEditField(e.target.value)} style={{...iS(T),marginBottom:0,fontSize:12}}>
                    {editFields.map(f=><option key={f.k} value={f.k}>{f.l}</option>)}
                  </select>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input value={editValue} onChange={e=>setEditValue(e.target.value)}
                    placeholder={editField==="acType"?"예: B787-9":editField==="crew"?"2, 3, 4 중":"숫자 입력"}
                    style={{...iS(T),marginBottom:0,flex:1,fontSize:13,fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,color:T.orange}}/>
                </div>
              </div>
            )}

            {/* Apply button */}
            {selected.size>0&&editValue.trim()&&(
              <button onClick={()=>setStep("confirm")} style={{
                width:"100%",padding:"14px",borderRadius:12,fontSize:14,fontWeight:700,cursor:"pointer",
                background:`linear-gradient(135deg,${T.accent},${T.blue})`,border:"none",color:"#fff",
                letterSpacing:0.5,
              }}>다음 — {selected.size}편에 적용 확인 →</button>
            )}
          </>
        )}

        {/* Step 2 — Confirm */}
        {step==="confirm"&&(
          <>
            <div style={{background:`${T.red}12`,border:`1px solid ${T.red}40`,borderRadius:12,padding:"16px",marginBottom:16}}>
              <div style={{fontSize:14,fontWeight:700,color:T.red,marginBottom:8}}>⚠ 변경 내용 확인</div>
              <div style={{fontSize:13,color:T.text,marginBottom:4}}>
                <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,color:T.accent}}>{selected.size}편</span>의
                <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700,color:T.orange}}> [{editField}]</span> 필드를
              </div>
              <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:20,fontWeight:700,color:T.green,marginBottom:4}}>"{editValue}"</div>
              <div style={{fontSize:11,color:T.muted}}>로 일괄 변경합니다. 이 작업은 되돌릴 수 없습니다.</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={()=>setStep("select")} style={{
                padding:"13px",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer",
                background:"transparent",border:`1.5px solid ${T.border}`,color:T.muted,
              }}>← 돌아가기</button>
              <button onClick={applyBatch} style={{
                padding:"13px",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer",
                background:`linear-gradient(135deg,${T.green},${T.blue})`,border:"none",color:"#fff",
              }}>✅ 적용</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────
function DetailModal({T, f, onClose, onEdit, onDelete}) {
  const [confirm,setConfirm]=useState(false);
  const ramp=calcRamp(f);
  return(
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:T.bg,zIndex:500,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <div style={{padding:"52px 16px 30px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            {f.flightNum&&<div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:11,fontWeight:700,color:T.accent,letterSpacing:2,marginBottom:4}}>{f.flightNum}</div>}
            <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:22,fontWeight:700,color:T.text,letterSpacing:1}}>{f.dep} → {f.arr}</div>
            <div style={{fontSize:11,color:T.muted,marginTop:3}}>{f.date} · {f.acType}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:32,fontWeight:700,color:T.accent,lineHeight:1}}>{fmtH(f.total)}</div>
            <div style={{fontSize:9,color:T.muted,letterSpacing:2}}>BLOCK</div>
          </div>
        </div>

        {/* Time row */}
        {(f.depTime||f.arrTime)&&(
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",marginBottom:10,display:"flex",justifyContent:"space-around",textAlign:"center"}}>
            {[{l:"OUT",v:f.depTime||"—"},{l:"IN",v:f.arrTime||"—"},{l:"총시간",v:fmtH(f.total)}].map(s=>(
              <div key={s.l}>
                <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>{s.l}</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:15,fontWeight:700,color:T.text}}>{s.v}</div>
              </div>
            ))}
          </div>
        )}

        {/* Detail grid */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
          {[{l:"기체",v:f.aircraft||"—"},{l:"기종",v:f.acType},{l:"PIC",v:fmtH(f.pic)},{l:"야간",v:fmtH(f.night)},{l:"IFR",v:fmtH(f.ifr)},{l:"이륙",v:f.to||0},{l:"착륙",v:f.ldDay||0},{l:"승무",v:FDP_LABEL[parseInt(f.crew)||4]}].map(s=>(
            <div key={s.l} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 12px"}}>
              <div style={{fontSize:9,color:T.muted,letterSpacing:1,textTransform:"uppercase",marginBottom:3}}>{s.l}</div>
              <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:600,color:T.text}}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* Ramp / FDP */}
        {ramp&&(
          <div style={{background:ramp.exceeds?T.warn:T.ok,border:`1px solid ${ramp.exceeds?T.warnB:T.okB}`,borderRadius:12,padding:"12px 14px",marginBottom:10}}>
            <div style={{fontSize:9,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",fontWeight:600,marginBottom:8}}>FDP (비행근무시간)</div>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:9,color:T.muted,marginBottom:3}}>Ramp Out KST</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:700,color:T.text}}>{ramp.roKst}</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:9,color:T.muted,marginBottom:3}}>FDP</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:20,fontWeight:700,color:ramp.exceeds?T.red:T.green}}>{fmtHrs(ramp.hrs)}</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:9,color:T.muted,marginBottom:3}}>Ramp In KST</div>
                <div style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:14,fontWeight:700,color:T.text}}>{ramp.riKst}</div>
              </div>
            </div>
          </div>
        )}

        {f.remarks&&(
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"12px 14px",marginBottom:10}}>
            <div style={{fontSize:9,color:T.muted,letterSpacing:1.5,textTransform:"uppercase",marginBottom:5}}>Remarks</div>
            <div style={{fontSize:13,color:T.text,lineHeight:1.6}}>{f.remarks}</div>
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:4}}>
          <button onClick={()=>onEdit(f)} style={{background:T.card,border:`1px solid ${T.blue}`,borderRadius:12,color:T.blue,padding:"13px",fontSize:13,fontWeight:700,cursor:"pointer"}}>✎ 수정</button>
          <button onClick={()=>confirm?onDelete(f.id):setConfirm(true)} style={{background:confirm?T.red:T.card,border:`1px solid ${T.red}`,borderRadius:12,color:confirm?"#fff":T.red,padding:"13px",fontSize:13,fontWeight:700,cursor:"pointer",transition:"all 0.2s"}}>{confirm?"확인":"🗑 삭제"}</button>
        </div>
        <button onClick={onClose} style={{width:"100%",marginTop:8,background:"none",border:`1px solid ${T.border}`,borderRadius:12,color:T.muted,padding:"12px",fontSize:13,cursor:"pointer"}}>닫기</button>
      </div>
    </div>
  );
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────
function EditModal({T, initial, onSave, onClose, notify}) {
  const [f,setF]=useState({...initial,pic:fmt1(initial.pic),sic:fmt1(initial.sic),night:fmt1(initial.night),ifr:fmt1(initial.ifr),xc:fmt1(initial.xc)});
  const upd=(k,v)=>setF(p=>({...p,[k]:v}));
  const save=()=>{
    if(!f.dep||!f.arr){notify("출발지/목적지 필수",true);return;}
    const total=decHrs(f.depTime,f.arrTime)||parseFloat(f.pic)||f.total||0;
    onSave({...f,total,pic:parseFloat(f.pic)||0,sic:parseFloat(f.sic)||0,night:parseFloat(f.night)||0,ifr:parseFloat(f.ifr)||0,xc:parseFloat(f.xc)||total,ldDay:parseInt(f.ldDay)||0,to:parseInt(f.to)||0});
  };
  return(
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:T.bg,zIndex:600,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <div style={{padding:"52px 14px 30px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:700,color:T.accent}}>EDIT FLIGHT</span>
          <button onClick={onClose} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,width:34,height:34,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div><Lbl T={T} mt={0}>편명</Lbl><input value={f.flightNum||""} onChange={e=>upd("flightNum",e.target.value.toUpperCase())} style={{...iS(T),fontFamily:"'SF Mono','Courier New',monospace",fontWeight:700}}/></div>
          <div><Lbl T={T} mt={0}>날짜</Lbl><input type="date" value={f.date} onChange={e=>upd("date",e.target.value)} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>출발</Lbl><input value={f.dep||""} onChange={e=>upd("dep",e.target.value.toUpperCase())} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>도착</Lbl><input value={f.arr||""} onChange={e=>upd("arr",e.target.value.toUpperCase())} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>OUT</Lbl><input type="time" value={f.depTime||""} onChange={e=>upd("depTime",e.target.value)} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>IN</Lbl><input type="time" value={f.arrTime||""} onChange={e=>upd("arrTime",e.target.value)} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>기체</Lbl><input value={f.aircraft||""} onChange={e=>upd("aircraft",e.target.value.toUpperCase())} style={iS(T)}/></div>
          <div><Lbl T={T} mt={0}>기종</Lbl><input value={f.acType||""} onChange={e=>upd("acType",e.target.value)} style={iS(T)}/></div>
        </div>
        <Lbl T={T}>승무 형태</Lbl>
        <select value={f.crew||"4"} onChange={e=>upd("crew",e.target.value)} style={{...iS(T),color:T.text}}>
          <option value="2">2인 승무 (FDP ≤13h)</option>
          <option value="3">3인 승무 (FDP ≤15h)</option>
          <option value="4">4인 승무 (FDP ≤18h)</option>
        </select>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div><Lbl T={T}>Ramp Out UTC</Lbl><input type="time" value={f.rampOutUtc||""} onChange={e=>upd("rampOutUtc",e.target.value)} style={iS(T)}/></div>
          <div><Lbl T={T}>Ramp In UTC</Lbl><input type="time" value={f.rampInUtc||""} onChange={e=>upd("rampInUtc",e.target.value)} style={iS(T)}/></div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <div><Lbl T={T}>Show Up UTC <span style={{fontSize:9,color:T.muted}}>— 야간수당</span></Lbl><input type="time" value={f.showUpUtc||""} onChange={e=>upd("showUpUtc",e.target.value)} style={iS(T)}/></div>
          <div/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          {[["pic","PIC"],["night","야간"],["ifr","IFR"]].map(([k,l])=>(
            <div key={k}><Lbl T={T}>{l}</Lbl><input type="number" step="0.01" value={f[k]||""} onChange={e=>upd(k,e.target.value)} style={{...iS(T),textAlign:"center"}}/></div>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {[["to","이륙"],["ldDay","착륙"]].map(([k,l])=>(
            <div key={k}><Lbl T={T}>{l}</Lbl><input type="number" min="0" value={f[k]||0} onChange={e=>upd(k,e.target.value)} style={{...iS(T),textAlign:"center",fontFamily:"'SF Mono','Courier New',monospace",fontSize:20,fontWeight:700}}/></div>
          ))}
        </div>
        <Lbl T={T}>비고</Lbl>
        <textarea value={f.remarks||""} onChange={e=>upd("remarks",e.target.value)} rows={2} style={{...iS(T),resize:"none"}}/>
        <button onClick={save} style={{width:"100%",marginTop:12,background:`linear-gradient(135deg,${T.accent},${T.blue})`,border:"none",borderRadius:14,color:"#fff",padding:"15px",fontSize:15,fontWeight:700,cursor:"pointer"}}>✓ 저장</button>
      </div>
    </div>
  );
}

// ─── Profile Modal ────────────────────────────────────────────────────────────
function ProfileModal({T, profile, setProfile, onClose, notify}) {
  const [l,setL]=useState({...profile});
  const upd=(k,v)=>setL(p=>({...p,[k]:v}));
  const fields=[{k:"name",label:"성명",ph:"홍길동"},{k:"airline",label:"항공사",ph:"대한항공"},{k:"empNo",label:"사번",ph:"P203001"},{k:"license",label:"자격증",ph:"ATPL-A"},{k:"base",label:"베이스 ICAO",ph:"RKSI"},{k:"acTypes",label:"운항 기종",ph:"B787-9"},{k:"medical",label:"Medical 만료일",type:"date"},{k:"hourlyRate",label:"통상시급 (원/시) — 야간수당 기준",ph:"25000",type:"number"},{k:"flightRate",label:"비행수당 (원/시) — 연장·3P 기준",ph:"15000",type:"number"}];
  return(
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:T.bg,zIndex:700,overflowY:"auto",animation:"slideUp 0.25s ease"}}>
      <div style={{padding:"52px 14px 30px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <span style={{fontFamily:"'SF Mono','Courier New',monospace",fontSize:13,fontWeight:700,color:T.accent}}>PROFILE</span>
          <button onClick={onClose} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,width:34,height:34,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
        </div>
        {fields.map(({k,label,ph,type})=>(
          <div key={k}><Lbl T={T}>{label}</Lbl>
            <input type={type||"text"} value={l[k]||""} placeholder={ph||""} onChange={e=>upd(k,e.target.value)} style={iS(T)}/>
          </div>
        ))}
        <button onClick={()=>{setProfile(l);notify("프로필 저장");onClose();}} style={{width:"100%",marginTop:16,background:`linear-gradient(135deg,${T.accent},${T.blue})`,border:"none",borderRadius:14,color:"#fff",padding:"15px",fontSize:15,fontWeight:700,cursor:"pointer"}}>저장</button>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const isDark=useTheme(), T=isDark?T_DARK:T_LIGHT;
  const [flights,setFlights]=useStore("aclv5_flights",makeSample());
  const [profile,setProfile]=useStore("aclv5_profile",{name:"위종석",empNo:"P203001",license:"ATPL-A",medical:"",airline:"대한항공",base:"RKSI",acTypes:"B787-9",hourlyRate:"",flightRate:""});
  const [tab,setTab]=useState(0);
  const [toast,setToast]=useState(null);
  const [modal,setModal]=useState(null);
  const [profOpen,setProfOpen]=useState(false);

  const notify=(msg,err=false)=>{setToast({msg,err});setTimeout(()=>setToast(null),2500);};
  const C=computeCompliance(flights);
  const totals=flights.reduce((a,f)=>({...a,total:a.total+(f.total||0),pic:a.pic+(f.pic||0),night:a.night+(f.night||0),flights:a.flights+1}),{total:0,pic:0,night:0,flights:0});

  const saveFlight=(f)=>{
    if(f.id){setFlights(p=>p.map(x=>x.id===f.id?f:x));notify("수정 완료");}
    else{setFlights(p=>[{...f,id:Date.now()},...p].sort((a,b)=>b.date.localeCompare(a.date)));notify("저장 완료");}
    setModal(null);
  };
  const deleteFlight=(id)=>{setFlights(p=>p.filter(f=>f.id!==id));setModal(null);notify("삭제",true);};

  const alertCount=[!C.toOk,!C.ldOk,C.hrs28/120>=0.9,C.hrs90/300>=0.9,profile.medical&&Math.ceil((new Date(profile.medical)-new Date())/86400000)<60].filter(Boolean).length;

  const TABS=[
    {icon:"⊞",label:"대시보드"},
    {icon:"📋",label:"로그북"},
    {icon:"✚",label:"입력",big:true},
    {icon:"📊",label:"통계"},
  ];

  const exportCSV=()=>{
    const hdr=["날짜","편명","출발","도착","총시간","PIC","야간","IFR","이륙","착륙","기체","기종","비고"];
    const rows=flights.map(f=>[f.date,f.flightNum||"",f.dep,f.arr,fmt1(f.total),fmt1(f.pic),fmt1(f.night),fmt1(f.ifr),f.to||0,f.ldDay||0,f.aircraft||"",f.acType||"",`"${(f.remarks||"").replace(/"/g,'""')}"`]);
    const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\uFEFF"+[hdr,...rows].map(r=>r.join(",")).join("\n")],{type:"text/csv;charset=utf-8"}));a.download=`logbook_${today()}.csv`;a.click();notify("CSV 저장");
  };

  return (
    <div style={{minHeight:"100dvh",maxWidth:430,margin:"0 auto",background:T.bg,color:T.text,fontFamily:"'SF Pro Text','Helvetica Neue',system-ui,sans-serif",position:"relative",overflow:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');
        *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
        input,select,textarea{-webkit-appearance:none;appearance:none}
        ::-webkit-scrollbar{width:2px}::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
        @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @keyframes slideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
        @keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(6px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        .fu{animation:fadeUp 0.28s ease both}
        .pressable{transition:opacity .12s,transform .12s}.pressable:active{opacity:.6;transform:scale(0.97)}
      `}</style>

      {/* Sticky header */}
      <div style={{padding:"50px 16px 12px",background:T.bg,borderBottom:`1px solid ${T.sep}`,position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <button onClick={()=>setProfOpen(true)} style={{background:"none",border:"none",padding:0,textAlign:"left",cursor:"pointer"}}>
            <div style={{fontSize:9,color:T.muted,letterSpacing:3,textTransform:"uppercase",fontWeight:600,marginBottom:1}}>CAPTAIN'S LOGBOOK</div>
            <div style={{fontSize:16,fontWeight:700,color:T.text,letterSpacing:0.2}}>{profile.name} <span style={{fontSize:11,color:T.muted,fontWeight:400}}>· {profile.airline}</span></div>
          </button>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {alertCount>0&&<div className="pulse" style={{fontSize:10,color:T.red,fontWeight:700}}>⚠ {alertCount}</div>}
            <button onClick={exportCSV} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.muted,padding:"6px 10px",fontSize:11,cursor:"pointer",fontWeight:600}}>CSV</button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{height:"calc(100dvh - 110px)",overflowY:"auto",paddingBottom:10,WebkitOverflowScrolling:"touch"}}>
        {tab===0&&<DashboardTab T={T} flights={flights} profile={profile} C={C} onMedical={v=>setProfile(p=>({...p,medical:v}))} onGotoLogs={()=>setTab(1)}/>}
        {tab===1&&<LogbookTab T={T} flights={flights} onDetail={f=>setModal({type:"detail",data:f})} onAdd={()=>setTab(2)}/>}
        {tab===2&&<AddTab T={T} onSave={saveFlight} notify={notify}/>}
        {tab===3&&<StatsTab T={T} flights={flights} setFlights={setFlights} profile={profile} setProfile={setProfile} notify={notify}/>}
      </div>

      {/* Bottom nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:T.tab,borderTop:`1px solid ${T.sep}`,display:"flex",paddingBottom:"env(safe-area-inset-bottom,8px)",backdropFilter:"blur(24px)",WebkitBackdropFilter:"blur(24px)",zIndex:100}}>
        {TABS.map((t,i)=>(
          <button key={i} onClick={()=>setTab(i)} className="pressable" style={{
            flex:1,padding:t.big?"6px 0 8px":"8px 0 6px",border:"none",background:"none",cursor:"pointer",
            borderTop:`2px solid ${tab===i?T.accent:"transparent"}`,
            color:tab===i?T.accent:T.muted,position:"relative",
          }}>
            <div style={{fontSize:i===2?24:17,lineHeight:1}}>{t.icon}</div>
            <div style={{fontSize:9,marginTop:2,fontWeight:tab===i?700:400,letterSpacing:0.3}}>{t.label}</div>
            {i===1&&alertCount>0&&<div style={{position:"absolute",top:4,right:"30%",background:T.red,color:"#fff",borderRadius:8,fontSize:8,fontWeight:700,padding:"1px 4px"}}>{alertCount}</div>}
          </button>
        ))}
      </div>

      {toast&&<div style={{position:"fixed",bottom:85,left:"50%",transform:"translateX(-50%)",background:toast.err?T.red:T.accent,color:"#fff",padding:"9px 20px",borderRadius:20,fontSize:12,zIndex:999,animation:"toastIn 0.25s ease",whiteSpace:"nowrap",fontWeight:700,boxShadow:"0 4px 20px rgba(0,0,0,0.3)"}}>{toast.msg}</div>}

      {modal?.type==="detail"&&<DetailModal T={T} f={modal.data} onClose={()=>setModal(null)} onEdit={f=>setModal({type:"edit",data:f})} onDelete={deleteFlight}/>}
      {modal?.type==="edit"&&<EditModal T={T} initial={modal.data} onSave={saveFlight} onClose={()=>setModal(null)} notify={notify}/>}
      {profOpen&&<ProfileModal T={T} profile={profile} setProfile={setProfile} onClose={()=>setProfOpen(false)} notify={notify}/>}
    </div>
  );
}
