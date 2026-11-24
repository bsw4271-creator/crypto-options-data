# crypto-options-data

Crypto Investment OS 홈 "시장 맥박"의 **BTC·ETH 옵션 위젯**에 쓸 자료를 모으는 공개 수집기입니다(공용 기억 `crypto-os-memory`의 ADR-046 3단계).

- 출처: Deribit 공개 API(키 없음). `get_book_summary_by_currency`(옵션 미결제약정·거래량·IV), `get_index_price`, `get_volatility_index_data`(DVOL).
- 계산: 풋콜 비율(미결제약정·24시간 거래량), 만기별 맥스페인·ATM IV·1표준편차 예상 변동폭, 이번 주 만기, 가장 큰 만기, DVOL 1년 IV 순위·백분위.
- 결과: `data/os/options-v1.json`(schema `crypto-options-data/os-bundle@1`). OS는 이 파일을 raw 주소로 읽기만 합니다.
- 실행: GitHub Actions 4시간마다. 공개 저장소라 실행 시간은 무료입니다. 비밀값 없음.
- 실패한 자산은 이전 값을 유지하고 `run.failed`에 이유를 남깁니다.

읽을 때 주의: 맥스페인·예상 변동폭은 시장 참여자의 포지션과 가격에서 나온 추정이며, 가격 예측이나 매매 신호가 아닙니다.

## 시험

```sh
node --test tests/*.test.mjs
```
