// 행또 데이터 빌더: 동행복권에서 당첨 결과·판매점·1등 기록을 모아 앱이 읽을 정적 JSON을 만든다.
// 매주 일요일(토요일 추첨 다음) GitHub Actions에서 실행해 GitHub Pages로 배포한다.
//
// 사용법
//   node data-server/build.mjs                         전체 (첫 실행은 판매점 목록 때문에 20~30분 걸림)
//   node data-server/build.mjs --province=서울 --district=서초구   일부만 (로컬 테스트용)
//   node data-server/build.mjs --skip-stores          판매점 목록 건너뛰기
//   node data-server/build.mjs --force-stores         판매점 목록 강제로 새로 받기
//
// 판매점 목록은 자주 바뀌지 않고 요청이 많아서(전국 약 800번), 마지막으로 받은 지 28일이 지났을 때만 새로 받는다.
//
// 결과: data-server/out/
//   meta.json                  { updatedAt, latestRound, provinces }
//   draws.json                 { 회차: { date, numbers, bonus, prizes } }   (지난 결과는 out/에서 이어받아 새 회차만 받는다)
//   wins/{시·도}.json          { id: { 판매점번호: 1등 횟수 }, key: { "도로명주소|상호": 1등 횟수 } }
//   stores/{시·도}.json        { districts: [...], stores: { 시·군·구: [판매점] } }
//   top-stores.json            전국 1등 많은 판매점 순위

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
const BASE = "https://www.dhlottery.co.kr";
const DELAY_MS = 800;        // 요청 사이 간격. 사이트에 부담을 주지 않도록 천천히 받는다.
const PAGE_SIZE = 10;        // 판매점 조회는 한 번에 10곳씩만 준다
const TOP_LIMIT = 200;
// 세종처럼 시·군·구가 없는 곳은 지역 목록이 [null]로 온다. "전체" 하나로 두고, 조회할 땐 빈 값으로 보낸다. (앱의 js/stores.js와 같아야 한다)
const WHOLE = "전체";
const warnings = [];
const STORES_MAX_AGE_DAYS = 28;

// [지역 목록 조회용 전체 이름, 판매점 조회용 줄인 이름] (앱의 js/stores.js와 같아야 한다)
const PROVINCES = [
  ["서울특별시", "서울"], ["경기도", "경기"], ["인천광역시", "인천"], ["부산광역시", "부산"],
  ["대구광역시", "대구"], ["대전광역시", "대전"], ["울산광역시", "울산"], ["세종특별자치시", "세종"],
  ["강원도", "강원"], ["충청북도", "충북"], ["충청남도", "충남"], ["전라북도", "전북"],
  ["전남광주통합특별시", "전남광주"], ["경상북도", "경북"], ["경상남도", "경남"], ["제주특별자치도", "제주"]
];
// 통합 전 기록은 예전 시·도 이름으로 남아 있다
const WIN_REGIONS = { "전남광주": ["전남광주", "광주", "전남"] };

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v ?? true];
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, params) {
  const url = BASE + path + "?" + new URLSearchParams(params);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await sleep(DELAY_MS);
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "haengtto-data-builder/1.0 (weekly; low volume)" },
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw new Error(`${path} 실패: ${err.message}`);
      console.warn(`  다시 시도 (${attempt}) ${path}: ${err.message}`);
      await sleep(5000 * attempt);
    }
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(join(OUT, file), "utf8")); } catch { return fallback; }
}

async function writeJson(file, data) {
  const path = join(OUT, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

// 1회 추첨: 2002-12-07(토). 결과는 21:00 KST 이후에 나온다.
function latestDrawnRound(now = new Date()) {
  const first = Date.UTC(2002, 11, 7, 12, 0);
  return Math.floor((now.getTime() - first) / (7 * 24 * 3600 * 1000)) + 1;
}

// ---------- 당첨 결과 ----------
function parseDraw(item) {
  const ymd = String(item.ltRflYmd);
  return {
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
    numbers: [1, 2, 3, 4, 5, 6].map((i) => Number(item["tm" + i + "WnNo"])),
    bonus: Number(item.bnsWnNo),
    prizes: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, Number(item["rnk" + r + "WnAmt"])]))
  };
}

async function buildDraws(latest) {
  const draws = await readJson("draws.json", {});
  let fetched = 0;
  // 한 번 조회하면 그 회차부터 아래로 10회차를 준다. 비어 있는 구간만 받는다.
  for (let round = latest; round >= 1; round -= 10) {
    const need = [];
    for (let r = round; r > round - 10 && r >= 1; r--) if (!draws[r]) need.push(r);
    if (!need.length) continue;
    const json = await getJson("/lt645/selectPstLt645InfoNew.do", { srchLtEpsd: String(round) });
    for (const item of (json?.data?.list ?? []).filter(Boolean)) draws[item.ltEpsd] = parseDraw(item);
    fetched++;
  }
  await writeJson("draws.json", draws);
  console.log(`당첨 결과: ${Object.keys(draws).length}회차 (새로 받은 요청 ${fetched}번)`);
}

// ---------- 1등 기록 ----------
// 같은 가게가 판매점 번호를 새로 받으면 기록이 나뉘므로 "도로명 주소(건물번호까지) + 상호"로도 센다 (앱의 storeKey와 같아야 한다)
function storeKey(address, name) {
  const m = String(address || "").match(/^(.+?(?:로|길))\s*(\d+(?:-\d+)?)/);
  if (!m || !name) return null;
  return (m[1] + m[2]).replace(/\s/g, "") + "|" + String(name).replace(/\s/g, "");
}

let failedWins = false;

async function buildWins(provinces) {
  const all = [];
  for (const [, short] of provinces) {
    const records = [];
    try {
      for (const region of WIN_REGIONS[short] ?? [short]) {
        const json = await getJson("/wnprchsplcsrch/selectLtWnShp.do", { srchWnShpRnk: "1", srchLtEpsd: "", srchShpLctn: region });
        records.push(...(json?.data?.list ?? []).filter(Boolean));
      }
    } catch (err) {
      warn(`1등 기록 ${short} 실패, 지난 데이터 유지: ${err.message}`);
      failedWins = true;
      continue;
    }
    const counts = { id: {}, key: {} };
    for (const r of records) {
      if (r.ltShpId) counts.id[r.ltShpId] = (counts.id[r.ltShpId] || 0) + 1;
      const k = storeKey(r.rdnm || r.shpAddr, r.shpNm);
      if (k) counts.key[k] = (counts.key[k] || 0) + 1;
    }
    await writeJson(`wins/${short}.json`, counts);
    all.push(...records);
    console.log(`1등 기록 ${short}: ${records.length}건, 판매점 ${Object.keys(counts.id).length}곳`);
  }
  return all;
}

// 판매점 번호와 주소+상호를 이어 같은 가게를 하나로 묶어 전국 순위를 만든다
function buildTop(records) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const r of records) {
    const id = "id:" + r.ltShpId;
    find(id);
    const k = storeKey(r.rdnm || r.shpAddr, r.shpNm);
    if (k) parent.set(find(id), find("key:" + k));
  }
  const groups = new Map();
  for (const r of records) {
    const g = find("id:" + r.ltShpId);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()]
    .map((rs) => {
      const latest = rs.reduce((a, b) => (b.draw > a.draw ? b : a));
      return {
        id: latest.ltShpId, name: latest.shpNm, address: latest.shpAddr || latest.rdnm, region: latest.region,
        lat: latest.shpLat, lng: latest.shpLot, wins: rs.length, lastRound: latest.draw,
        open: latest.status !== "폐점", online: latest.ltShpId === "51100000"
      };
    })
    .sort((a, b) => b.wins - a.wins || b.lastRound - a.lastRound)
    .slice(0, TOP_LIMIT);
}

// ---------- 판매점 목록 ----------
function toStore(item) {
  return {
    id: item.ltShpId,
    name: item.conmNm,
    address: item.bplcRdnmDaddr || [item.tm1BplcLctnAddr, item.tm2BplcLctnAddr, item.tm3BplcLctnAddr, item.bplcLctnDaddr].filter(Boolean).join(" "),
    phone: item.shpTelno || "",
    lat: Number(item.shpLat),
    lng: Number(item.shpLot)
  };
}

async function fetchDistrictStores(short, district) {
  const params = (page) => ({
    srchCtpvNm: short, srchSggNm: district === WHOLE ? "" : district, l645LtNtslYn: "Y", l520LtNtslYn: "N", st5LtNtslYn: "N",
    st10LtNtslYn: "N", st20LtNtslYn: "N", cpexUsePsbltyYn: "N", pageNum: String(page), recordCountPerPage: String(PAGE_SIZE), pageCount: "5"
  });
  const first = await getJson("/prchsplcsrch/selectLtShp.do", params(1));
  const total = Number(first?.data?.total) || 0;
  const list = (first?.data?.list ?? []).filter(Boolean).map(toStore);
  for (let page = 2; page <= Math.ceil(total / PAGE_SIZE); page++) {
    const json = await getJson("/prchsplcsrch/selectLtShp.do", params(page));
    list.push(...(json?.data?.list ?? []).filter(Boolean).map(toStore));
  }
  return list.filter((s) => s.lat && s.lng);
}

// 한 시·도나 시·군·구가 실패해도 전체를 멈추지 않는다. 실패한 곳은 지난번 데이터를 그대로 두고 경고로 남긴다.
async function buildStores(provinces) {
  for (const [full, short] of provinces) {
    const file = `stores/${short}.json`;
    const previous = await readJson(file, {});
    let districts;
    try {
      const json = await getJson("/prchsplcsrch/selectAdmdst.do", { srchCtpvNm: full });
      districts = (json?.data?.list ?? []).filter(Boolean).map((x) => x.sggNm).filter(Boolean);
      if (!districts.length) districts = [WHOLE];
    } catch (err) {
      warn(`판매점 ${short} 지역 목록 실패, 지난 데이터 유지: ${err.message}`);
      continue;
    }
    const data = { districts, stores: previous.stores ?? {} };
    for (const district of districts) {
      if (args.district && district !== args.district) continue;
      try {
        data.stores[district] = await fetchDistrictStores(short, district);
        console.log(`판매점 ${short} ${district}: ${data.stores[district].length}곳`);
      } catch (err) {
        warn(`판매점 ${short} ${district} 실패, 지난 데이터 유지: ${err.message}`);
      }
    }
    await writeJson(file, data);
  }
}

function warn(message) {
  warnings.push(message);
  console.warn("⚠️ " + message);
}

// ---------- 실행 ----------
const started = Date.now();
const provinces = args.province ? PROVINCES.filter((p) => p[1] === args.province || p[0] === args.province) : PROVINCES;
if (!provinces.length) throw new Error("알 수 없는 시·도: " + args.province);
const latest = latestDrawnRound();

if (!args["skip-draws"]) await buildDraws(latest);
if (!args["skip-wins"]) {
  const records = await buildWins(provinces);
  // 전국 순위는 모든 시·도를 받았을 때만 새로 만든다
  if (!args.province && !failedWins) await writeJson("top-stores.json", { latestRound: latest, stores: buildTop(records) });
}
const meta = await readJson("meta.json", {});
const storesAgeDays = meta.storesUpdatedAt ? (Date.now() - Date.parse(meta.storesUpdatedAt)) / 86400000 : Infinity;
let storesUpdatedAt = meta.storesUpdatedAt;
if (args["skip-stores"]) {
  console.log("판매점 목록: 건너뜀");
} else if (!args["force-stores"] && !args.province && storesAgeDays < STORES_MAX_AGE_DAYS) {
  console.log(`판매점 목록: ${Math.floor(storesAgeDays)}일 전에 받아서 건너뜀 (${STORES_MAX_AGE_DAYS}일마다 새로 받음)`);
} else {
  await buildStores(provinces);
  if (!args.province) storesUpdatedAt = new Date().toISOString();
}

await writeJson("meta.json", {
  ...meta,
  storesUpdatedAt,
  version: 1,
  updatedAt: new Date().toISOString(),
  latestRound: latest,
  provinces: PROVINCES.map((p) => p[1]),
  warnings
});
console.log(`완료: ${Math.round((Date.now() - started) / 1000)}초, 경고 ${warnings.length}건, 결과 → ${OUT}`);
