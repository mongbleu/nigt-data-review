// 시험 전용 시계(tests/game_api.mjs가 개발 서버를 띄울 때 NODE_OPTIONS=--import로 넣음) — 운영 코드에는 쓰지 않는다.
//   환경변수 NR_TEST_CLOCK_FILE 파일에 적힌 ms만큼 Date.now()를 앞으로 돌린다(신청 24시간 만료 시험용). 파일은 0.05초마다 다시 읽음.
import { readFileSync } from 'node:fs';

const file = process.env.NR_TEST_CLOCK_FILE;
if (file) {
  const real = Date.now.bind(Date);
  let off = 0, seen = 0;
  Date.now = () => {
    const t = real();
    if (t - seen > 50) {
      seen = t;
      try { off = Number(readFileSync(file, 'utf8')) || 0; } catch { off = 0; }
    }
    return t + off;
  };
}
