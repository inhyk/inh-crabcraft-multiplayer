# 충돌 데이터 생성과 검증

`src/sim/world/`는 DOM, three.js, GLB 없이 충돌 JSON을 읽고 높이, 이동 충돌, 시야 차단을 계산한다. 브라우저의 `layoutClawhaven`, `layoutStarhaven`, `layoutDawnreach` 등록 함수를 Node에서 그대로 실행해 `public/world/collision-w1.json`, `collision-w2.json`, `collision-w3.json`을 만든다. 고체 충돌은 그래픽 품질에 영향을 받지 않는다. 낮은 품질에서는 장식, 그림자와 LOD를 줄인다.

다시 만들기는 `node tools/bake-collision.mjs`, 최신 상태 검사는 `node tools/bake-collision.mjs --check`다. bake 입력 소스의 해시가 달라지면 CI가 실패하므로 충돌에 관련된 코드를 바꾼 PR에서 JSON도 다시 만든다. 생성 과정이 DOM이나 렌더 모듈에 의존하면 경계 테스트도 실패한다.

실제 Chrome과 Node 비교는 `node tools/qa-collision-bake.mjs --url http://127.0.0.1:<port>/ --quality low`와 `--quality high`로 실행한다. 각 품질에서 월드 I 14,764점, II 10,438점, III 10,294점의 높이와 이동 충돌, 시야 차단을 검사했다. 최대 오차는 6.53e-9, 시야 차단 판정 차이는 0건이었다. 요구 기준은 1e-6이다. Node 24에서도 충돌 테스트 4건과 bake 최신 상태 검사를 통과했다.
