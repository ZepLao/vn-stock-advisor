import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intradayWindow } from '../src/intraday.js';
import { suggest, formatDiagnosis } from '../src/diagnose.js';

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Khung thu thập trong phiên: bỏ ATO, nghỉ trưa, ATC và cuối tuần', () => {
  const d = '2026-10-22';
  assert.equal(intradayWindow(at(d, '09:10')), false);
  assert.equal(intradayWindow(at(d, '09:15')), true);
  assert.equal(intradayWindow(at(d, '12:00')), false);
  assert.equal(intradayWindow(at(d, '13:30')), true);
  assert.equal(intradayWindow(at(d, '14:50')), false);
  assert.equal(intradayWindow(at('2026-10-24', '10:00')), false);
});

test('Chưa đủ mẫu: không đề xuất gì', () => {
  assert.deepEqual(suggest({
    accuracy: [{ source: 'rank_all', horizon: 10, evaluated: 30, beat_index_rate: 0.2 }],
    fill: { n: 5, fill_rate: 0.1 }, hours: [{ hour: 10, n: 100, to_close: 0.01 }],
    news: [{ label: 'TICH_CUC', n: 10, avg_excess: 0.01 }, { label: 'TIEU_CUC', n: 10, avg_excess: -0.01 }],
  }), []);
});

test('Đủ mẫu: đề xuất theo từng vùng', () => {
  const s = suggest({
    accuracy: [
      { source: 'ai', horizon: 10, evaluated: 150, beat_index_rate: 0.4 },
      { source: 'rank_all', horizon: 10, evaluated: 2000, beat_index_rate: 0.58 },
      { source: 'rule', horizon: 10, evaluated: 300, beat_index_rate: 0.5 }, // trong ngưỡng: không nói
      // Kém VN-Index nhưng hơn rổ đồng tỷ trọng (chỉ số bị vài mã lớn kéo): chưa kết luận
      { source: 'final', horizon: 10, evaluated: 200, beat_index_rate: 0.3, beat_basket_rate: 0.6 },
    ],
    fill: { n: 40, fill_rate: 0.3 },
    hours: [{ hour: 9, n: 1000, to_close: -0.002 }, { hour: 10, n: 1000, to_close: 0.003 }, { hour: 13, n: 1000, to_close: 0.001 }],
    news: [{ label: 'TICH_CUC', n: 80, avg_excess: 0.004 }, { label: 'TIEU_CUC', n: 60, avg_excess: -0.003 }],
  });
  assert.deepEqual(s.map((x) => x.area), ['source', 'source', 'zone', 'timing', 'news']);
  assert.match(s[0].text, /"ai".*40%/);
  assert.match(s[3].text, /10h/);
  assert.match(s[4].text, /có giá trị/);
});

test('Tin Telegram chẩn đoán khi chưa có dữ liệu', () => {
  const t = formatDiagnosis({ date: '2026-10-22', accuracy: [], fill: { n: 0 }, hours: [], news: [], suggestions: [] });
  assert.match(t, /CHẨN ĐOÁN DỰ ĐOÁN 22\/10/);
  assert.match(t, /Chưa có dự đoán nào đủ 10 phiên/);
  assert.match(t, /Chưa đủ mẫu/);
});

test('Đối chiếu dự báo giá AI, độ tự tin, mua chủ động, yếu tố và triển vọng tuần', () => {
  const s = suggest({
    forecast: [{ h: 5, n: 60, coverage: 0.9, err_ai: 0.04, err_naive: 0.03, dir_hit: 0.5, top_hit: 0.25 }],
    confidence: [
      { who: 'ai', conf_band: 'cao (≥75)', n: 40, beat: 0.45 }, { who: 'ai', conf_band: 'vừa (60–74)', n: 50, beat: 0.5 },
      { who: 'committee', conf_band: 'cao (≥75)', n: 10, beat: 0.9 }, // chưa đủ mẫu
    ],
    flow: [{ tercile: 1, n: 150, avg_excess: -0.004 }, { tercile: 3, n: 150, avg_excess: 0.006 }],
    factors: [
      { factor: 'f_mom', days: 25, ic: 0.08, sd: 0.1 }, // t = 4
      { factor: 'pe', days: 25, ic: -0.06, sd: 0.1 }, // t = -3
      { factor: 'roe', days: 25, ic: 0.01, sd: 0.1 }, // nhiễu
      { factor: 'f_adx', days: 10, ic: 0.2, sd: 0.1 }, // chưa đủ phiên
    ],
    outlook: { n: 10, hit: 0.5 },
  });
  assert.deepEqual(s.map((x) => x.area), ['forecast', 'forecast', 'confidence', 'flow', 'factor', 'factor', 'outlook']);
  assert.match(s[0].text, /giá đứng yên/);
  assert.match(s[2].text, /Gemini.*chưa có giá trị/);
  assert.match(s[3].text, /có giá trị/);
  assert.match(s[4].text, /f_mom.*đúng chiều/);
  assert.match(s[5].text, /pe.*NGƯỢC/);
  const t = formatDiagnosis({ date: '2026-10-30', accuracy: [], fill: { n: 0 }, hours: [], news: [],
    forecast: [{ h: 5, n: 60, coverage: 0.9, err_ai: 0.04, err_naive: 0.03 }], factors: [{ factor: 'f_mom', days: 25, ic: 0.08 }], suggestions: s });
  assert.match(t, /Dải giá 5 phiên chứa giá thật: 90%/);
  assert.match(t, /IC yếu tố/);
});
