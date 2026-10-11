# 행또 데이터 서버

동행복권에서 당첨 결과, 로또 판매점, 판매점별 역대 1등 횟수를 매주 한 번 모아서
작은 JSON 파일로 만들고 GitHub Pages로 배포해요. 행또 앱은 동행복권 대신 이 파일을 읽어요.

## 만드는 파일 (`out/`)

| 파일 | 내용 | 크기(대략) |
|---|---|---|
| `meta.json` | 마지막 업데이트 시각, 마지막 추첨 회차 | 1KB |
| `draws.json` | 1회부터 최신 회차까지 당첨번호·보너스·등수별 당첨금 | 170KB |
| `wins/{시·도}.json` | 판매점별 역대 1등 횟수 (판매점 번호 기준, 주소+상호 기준) | 시·도당 수십 KB |
| `stores/{시·도}.json` | 시·군·구 목록과 지역별 로또 6/45 판매점 | 시·도당 수십~수백 KB |
| `top-stores.json` | 전국 1등 많은 판매점 순위 200곳 | 40KB |

## 실행 주기

- 매주 토요일 21:00(KST)에 자동 실행돼요. GitHub의 예약 실행은 몇 분~수십 분 늦게 시작될 수 있어요. 직접 실행하려면 Actions 탭에서 "행또 데이터 업데이트" → Run workflow.
- 당첨 결과는 새 회차만, 1등 기록은 매주, 판매점 목록은 28일마다 새로 받아요.
- 동행복권에 부담을 주지 않도록 요청 사이에 0.8초씩 쉬어요. 첫 실행은 판매점 목록 때문에 20~30분 걸려요.

## 처음 설정하기

1. GitHub에서 **공개(Public)** 저장소를 만들어요. 예: `haengtto-data` (무료 GitHub Pages는 공개 저장소에서만 돼요. 이 저장소에는 데이터 수집 코드만 들어가요.)
2. 이 폴더의 파일을 저장소 맨 위에 올려요: `build.mjs`, `README.md`, `.github/workflows/update-data.yml`
3. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿔요.
4. **Settings → Actions → General → Workflow permissions**를 **Read and write permissions**로 바꿔요.
5. **Actions** 탭에서 "행또 데이터 업데이트"를 열고 **Run workflow**로 첫 실행을 해요.
6. 끝나면 `https://{GitHub 아이디}.github.io/haengtto-data/meta.json`이 열리는지 확인해요.
7. 앱의 `js/data-source.js`에 있는 `PUBLISHED_URL`에 `https://{GitHub 아이디}.github.io/haengtto-data/`를 넣어요.

## 로컬에서 실행

```bash
node build.mjs --province=서울 --district=서초구
```

Node.js 18 이상이 필요해요(외부 패키지 없음). 옵션: `--province=서울` 일부 시·도만, `--district=서초구` 일부 시·군·구만,
`--skip-stores`, `--skip-wins`, `--skip-draws`, `--force-stores`.

## 주의

- 동행복권의 공식 공개 API가 아니라 사이트가 쓰는 조회 경로를 써요. 사이트가 바뀌면 `build.mjs`의 경로와 필드 이름을 고쳐야 해요.
- 수집 실패 시 Actions가 실패로 표시되고, 앱은 지난주 파일을 그대로 쓰거나 동행복권에서 직접 받아요.
