# 전투 출력 분리 구현과 검증

전투 출력은 `src/game/events.ts`의 이벤트와 `browserSink.ts`의 브라우저 수신부로 나눴다. 명중은 `Unit.updateHit()`, 투사체는 `Projectiles`, 전투 지연 작업은 `SimTimers`의 게임 시간을 따른다. 화면을 갱신하지 않는 Node에서도 실제 전투와 보스 기믹을 실행하고 사건을 검사한다. 능력과 적 공격 9가지의 명중은 디스크의 실제 클립 hit와 1 ms 안에서 일치한다.

`Player`의 카메라 방향과 키 입력은 이번 단계에서 유지한다. S2의 `PlayerInput`에서 옮긴다. S1은 아직 서버가 공개 세계의 권한자가 되는 단계가 아니다. 공개 세계 전투와 진행 저장의 권한 이전은 S5, S6에서 적용한다.

검사 명령은 `pnpm test:sim`, `pnpm test:boss`, `pnpm test:engine`, `pnpm test:multiplayer`, `pnpm test:server`와 `node tools/playtest.mjs`다. 두 브라우저 검사는 `CC_QA_BASE=http://127.0.0.1:<preview-port> node tools/qa-mixed-combat-language.mjs`로 실행한다. 시작 안내를 확인하고 제작자 이동 fixture로 월드 II 전투를 준비한다.
