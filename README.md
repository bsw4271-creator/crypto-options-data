# crypto-options-data

Crypto Investment OS 홈 "시장 맥박"의 **BTC·ETH 옵션 위젯**에 쓸 자료를 모으는 공개 수집기입니다(공용 기억 `crypto-os-memory`의 ADR-046 3단계).

- 출처: Deribit 공개 API(키 없음). `get_book_summary_by_currency`(옵션 미결제약정·거래량·IV), `get_index_price`, `get_volatility_index_data`(DVOL).
- 계산: 풋콜 비율(미결제약정·24시간 거래량), 만기별 맥스페인·ATM IV·1표준편차 예상 변동폭, 이번 주 만기, 가장 큰 만기, DVOL 1년 IV 순위·백분위.
- 결과: `data/os/options-v1.json`(schema `crypto-options-data/os-bundle@1`). OS는 이 파일을 raw 주소로 읽기만 합니다.
- 실행: GitHub Actions 4시간마다. 공개 저장소라 실행 시간은 무료입니다. BTC·ETH 부분은 비밀값 없음.
- 실패한 자산은 이전 값을 유지하고 `run.failed`에 이유를 남깁니다.

읽을 때 주의: 맥스페인·예상 변동폭은 시장 참여자의 포지션과 가격에서 나온 추정이며, 가격 예측이나 매매 신호가 아닙니다.

## 미국 주식 (ADR-047 5단계)

- 결과: `data/os/us-v1.json`(schema `crypto-options-data/us-bundle@1`), 같은 4시간 실행에서 만든다.
- **옵션은 여기서 모으지 않는다.** 이 저장소는 공개 저장소다. OS가 쓰는 옵션 출처(Marketdata.app 무료 플랜)는 개인 이용 허가라 재배포를 금지하므로, SPY·QQQ 옵션 요약과 실적 종목의 옵션 예상 변동폭은 OS가 Cloudflare Access 뒤에서 직접 받아 본인 화면에만 보여 준다. (Cboe 공개 지연 시세는 GitHub Actions에서 HTTP 403으로 막혀 2026-11-26에 뺐다.)
- **실적 주목 종목**: Finnhub 무료 실적 일정(이번 주 월~금, 뉴욕 기준) → 매출 예상치 상위 10. 종목마다 발표일·시간(장전/장후), 컨센서스 EPS·매출, 발표 뒤 실제 값, 최근 4분기 상회 횟수.
- **미국 바이오**: Tiingo 무료 일봉으로 XBI 대 SPY(1주·1달·3달)와 바이오 9종목 순위. Tiingo 무료 한도를 다른 수집기와 나눠 쓰므로 하루 1번만 부른다.
- 비밀값: Actions Secrets `FINNHUB_API_KEY`, `TIINGO_API_KEY`(무료 키). 요청 헤더로만 보내고 결과 파일·기록에 남기지 않는다.

읽을 때 주의: 위스퍼 숫자(기대 EPS)가 아니라 공개 컨센서스다. 매매 신호가 아니다.

## 시험

```sh
node --test tests/*.test.mjs
```
