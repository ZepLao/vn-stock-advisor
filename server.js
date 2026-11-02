// Web server: phục vụ dashboard (public/) và các API JSON.
import './src/env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSymbol, getMarketOverview } from './src/analyze.js';
import { aiConfig } from './src/ai.js';
import { testProviders } from './src/llm.js';
import { getMarketMovers, screenCriteria } from './src/data.js';
import { getScreener, startScreener, rerunScreenerAi, startScreenerSchedule } from './src/screener.js';
import { runBacktest, listStrategies } from './src/backtest.js';
import { startCommittee, getCommittee } from './src/committee.js';
import { getPortfolio, addTransaction, removeTransaction, removeSymbol, addCash, removeCash } from './src/portfolio.js';
import { getRankBoard, runRankPortfolio } from './src/ranking.js';
import { runLiveBacktest } from './src/livebacktest.js';
import { runRollingPortfolio } from './src/rolling.js';
import { evaluatePredictions } from './src/predictions.js';
import { getVerification } from './src/verify.js';
import { startHistorySchedule, listSnapshots } from './src/history.js';
import { getSectorFlows } from './src/sectors.js';
import { getChartSeries } from './src/chartdata.js';
import { startFlowCapture } from './src/orderflow.js';
import { getForecast } from './src/forecast.js';
import { telegramConfig, sendReport, buildReport, startTelegramSchedule, sendMessage } from './src/telegram.js';
import { startSelfReview, runSelfReview, lastReview } from './src/selfreview.js';
import { getTuning, tuningLog } from './src/tuning.js';
import { getMarketRegime } from './src/regime.js';
import { startDbSync, syncAll } from './src/db.js';
import { startRadar, getRadar, radarTick, RADAR } from './src/radar.js';
import { startHoldWatch, HOLD_RULES } from './src/holdwatch.js';
import { startTelegramBot } from './src/telegrambot.js';
import { startOutlookSchedule, buildOutlook, getOutlook, formatOutlook } from './src/outlook.js';
import { startIntraday, captureIntraday, INTRADAY_MINUTES } from './src/intraday.js';
import { startDiagnose, runDiagnosis, lastDiagnosis } from './src/diagnose.js';
import { getAutoTrade, openAccount, resetAccount, runAutoTrade, startAutoTradeSchedule, syncFunding } from './src/autotrade.js';
import {
  getWatchlist, addToWatchlist, removeFromWatchlist, scanWatchlist,
  getAlerts, markAlertsRead, startMonitor, runAi, getAiResult, triggerTestAlert,
} from './src/tracker.js';

const PORT = Number(process.env.PORT) || 3000;
const SCAN_MINUTES = Number(process.env.SCAN_MINUTES) || 10;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err?.message || err);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e5) throw new Error('Request quá lớn');
  }
  return data ? JSON.parse(data) : {};
}

const SYMBOL_RE = /^[A-Za-z0-9]{3,10}$/;

const routes = [
  ['GET', /^\/api\/analyze\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await analyzeSymbol(sym));
  }],
  ['GET', /^\/api\/market$/, async (req, res) => send(res, 200, await getMarketOverview())],
  // Quá khứ → tương lai: dải giá thống kê, kịch bản AI, kiểm chứng: /api/forecast/FPT?h=5|10|20|60
  ['GET', /^\/api\/forecast\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const s = sym.toUpperCase();
    const h = new URL(req.url, 'http://localhost').searchParams.get('h');
    send(res, 200, await getForecast(s, { horizon: h, ai: await getAiResult(s) }));
  }],
  // Biểu đồ theo khung: /api/chart/FPT?tf=D|W|M (nến ngày / tuần / tháng kèm MA20/50/200 của khung đó)
  ['GET', /^\/api\/chart\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const tf = (new URL(req.url, 'http://localhost').searchParams.get('tf') || 'D').toUpperCase();
    send(res, 200, await getChartSeries(sym.toUpperCase(), tf));
  }],
  // Cổ phiếu tiềm năng: trạng thái/kết quả, quét lại toàn bộ, hoặc chỉ chạy lại bước Gemini
  ['GET', /^\/api\/screener$/, async (req, res) => send(res, 200, await getScreener())],
  ['POST', /^\/api\/screener\/run$/, async (req, res) => send(res, 200, await startScreener())],
  ['POST', /^\/api\/screener\/ai$/, async (req, res) => send(res, 200, await rerunScreenerAi())],
  // Top tăng/giảm, giá trị giao dịch, khối ngoại mua/bán ròng của sàn được theo dõi (mặc định HOSE): /api/movers?floor=HOSE
  ['GET', /^\/api\/movers$/, async (req, res) => {
    const floor = (new URL(req.url, 'http://localhost').searchParams.get('floor') || 'HOSE').toUpperCase();
    const { floors } = screenCriteria();
    if (!floors.includes(floor)) return send(res, 400, { error: `Tool chỉ theo dõi sàn ${floors.join(', ')}` });
    send(res, 200, await getMarketMovers(floor));
  }],
  ['GET', /^\/api\/ai\/status$/, async (req, res) => send(res, 200, aiConfig())],
  // Gửi yêu cầu nhỏ tới từng nhà cung cấp AI để kiểm tra key
  ['POST', /^\/api\/ai\/test$/, async (req, res) => send(res, 200, await testProviders())],
  ['GET', /^\/api\/ai\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await getAiResult(sym));
  }],
  ['POST', /^\/api\/ai\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const { force } = await readBody(req);
    send(res, 200, await runAi(sym, { force: Boolean(force) }));
  }],
  // Backtest theo luật thị trường VN: /api/backtest/FPT?strategy=score&years=3&buy=30&sell=-10&stop=7
  ['GET', /^\/api\/backtest\/strategies$/, async (req, res) => send(res, 200, listStrategies())],
  ['GET', /^\/api\/backtest\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runBacktest(sym, {
      strategy: q.strategy, years: q.years, params: q,
      stopLossPct: q.stop, takeProfitPct: q.take, positionPct: q.position, initialCash: q.cash,
    }));
  }],
  // Quy trình quyết định: Gemini → phe mua / phe bán → giám đốc đầu tư. POST bắt đầu ({ force }), GET xem tiến độ và kết quả
  ['GET', /^\/api\/committee\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await getCommittee(sym));
  }],
  ['POST', /^\/api\/committee\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const { force } = await readBody(req).catch(() => ({}));
    send(res, 200, await startCommittee(sym, { force: Boolean(force) }));
  }],
  // Xếp hạng 4 yếu tố, backtest danh mục top N, độ chính xác của các dự đoán đã ghi
  ['GET', /^\/api\/rank$/, async (req, res) => {
    const { ref, ...board } = await getRankBoard();
    send(res, 200, board);
  }],
  // Siêu cổ phiếu chuẩn xu hướng 8 năm (Trend Picks)
  ['GET', /^\/api\/trend-picks$/, async (req, res) => {
    const board = await getRankBoard();
    const items = (board.rows || []).filter((r) => r.trendPick);
    send(res, 200, { date: board.date, count: items.length, items });
  }],
  // Quét cổ phiếu rủi ro cao / lao dốc trên thị trường
  ['GET', /^\/api\/risk-scanner$/, async (req, res) => {
    const board = await getRankBoard();
    const items = (board.rows || []).filter((r) => r.trend?.trendState === 'DOWN' && r.factors?.high <= -0.30);
    send(res, 200, { date: board.date, count: items.length, items });
  }],
  // Metadata tên và ngành 2.000+ mã chứng khoán Việt Nam
  ['GET', /^\/api\/stock-names$/, async (req, res) => {
    try {
      const file = join(dirname(fileURLToPath(import.meta.url)), 'data', 'stock_names.json');
      const content = await readFile(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(content);
    } catch {
      send(res, 200, {});
    }
  }],
  // Chế độ thị trường: Đếm ngày phân phối, độ rộng thị trường & kiểm soát tỷ trọng
  ['GET', /^\/api\/market-regime$/, async (req, res) => send(res, 200, await getMarketRegime())],
  ['GET', /^\/api\/rank\/backtest$/, async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runRankPortfolio({ years: q.years, top: q.top, rebalance: q.rebalance, buffer: q.buffer, earnings: q.earnings, trendFilter: q.trend, regime: q.regime, initialCash: q.cash }));
  }],
  // Backtest đúng quy trình khuyến nghị: vùng mua chia lần, cắt lỗ neo ngày mua, chốt 1/3, regime, định cỡ theo rủi ro
  ['GET', /^\/api\/live-backtest$/, async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runLiveBacktest({ years: q.years, initialCash: q.cash, regimeFilter: q.regime }));
  }],
  // Backtest quy tắc đang dùng: danh mục cuốn chiếu (10 mã, ≤ 3/ngành, bổ sung mỗi 5 phiên, giữ 40 phiên, không cắt lỗ)
  ['GET', /^\/api\/rolling-backtest$/, async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runRollingPortfolio({ years: q.years, initialCash: q.cash, ...(q.sizing ? { sizing: q.sizing } : {}), ...(q.stop ? { stopPct: Number(q.stop) } : {}) }));
  }],
  ['GET', /^\/api\/predictions$/, async (req, res) => send(res, 200, await evaluatePredictions())],
  // Kiểm chứng các giả thuyết chọn trước (IC, nhóm mua, độ phủ dải, AI so với luật) kèm t Newey-West
  ['GET', /^\/api\/verification$/, async (req, res) => send(res, 200, await getVerification())],
  ['GET', /^\/api\/history$/, async (req, res) => send(res, 200, { dates: await listSnapshots() })],
  // Dòng tiền theo nhóm ngành: /api/sectors?period=1|5|20
  ['GET', /^\/api\/sectors$/, async (req, res) => {
    const period = new URL(req.url, 'http://localhost').searchParams.get('period') || '1';
    send(res, 200, await getSectorFlows(period));
  }],
  // Tool tự đầu tư (tài khoản giấy, vốn = vốn thực nạp ròng): xem, mở, đặt lại, xử lý phiên đã chốt ngay
  ['GET', /^\/api\/autotrade$/, async (req, res) => send(res, 200, await getAutoTrade())],
  ['POST', /^\/api\/autotrade\/open$/, async (req, res) => {
    try {
      send(res, 200, await openAccount());
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }],
  ['POST', /^\/api\/autotrade\/reset$/, async (req, res) => send(res, 200, await resetAccount())],
  ['POST', /^\/api\/autotrade\/run$/, async (req, res) => { await runAutoTrade(); send(res, 200, await getAutoTrade()); }],
  // Danh mục đầu tư thực tế
  ['GET', /^\/api\/portfolio$/, async (req, res) => send(res, 200, await getPortfolio())],
  ['POST', /^\/api\/portfolio\/tx$/, async (req, res) => {
    try {
      send(res, 200, await addTransaction(await readBody(req)));
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }],
  ['DELETE', /^\/api\/portfolio\/tx\/([^/]+)$/, async (req, res, [id]) => send(res, 200, await removeTransaction(id))],
  ['DELETE', /^\/api\/portfolio\/symbol\/([^/]+)$/, async (req, res, [sym]) => {
    try {
      send(res, 200, await removeSymbol(sym));
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }],
  // Quản lý vốn: nạp / rút / cổ tức tiền / đặt số dư
  ['POST', /^\/api\/portfolio\/cash$/, async (req, res) => {
    try {
      const c = await addCash(await readBody(req));
      await syncFunding().catch(() => {}); // tool tự đầu tư nạp / rút theo ngay
      send(res, 200, c);
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }],
  ['DELETE', /^\/api\/portfolio\/cash\/([^/]+)$/, async (req, res, [id]) => {
    const r = await removeCash(id);
    await syncFunding().catch(() => {}); // tool tự đầu tư nạp / rút theo ngay
    send(res, 200, r);
  }],
  ['GET', /^\/api\/watchlist$/, async (req, res) => send(res, 200, await getWatchlist())],
  ['POST', /^\/api\/watchlist$/, async (req, res) => {
    const body = await readBody(req);
    if (!SYMBOL_RE.test(body.symbol || '')) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const entry = await addToWatchlist(body.symbol, body);
    scanWatchlist().catch(() => {});
    send(res, 200, entry);
  }],
  ['DELETE', /^\/api\/watchlist\/([^/]+)$/, async (req, res, [sym]) => {
    await removeFromWatchlist(sym);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/scan$/, async (req, res) => send(res, 200, await scanWatchlist())],
  ['GET', /^\/api\/alerts$/, async (req, res) => send(res, 200, await getAlerts())],
  ['GET', /^\/api\/radar$/, async (req, res) => send(res, 200, await getRadar())],
  ['GET', /^\/api\/diagnostics$/, async (req, res) => send(res, 200, await lastDiagnosis())],
  ['GET', /^\/api\/outlook$/, async (req, res) => send(res, 200, await getOutlook())],
  // Phân tích triển vọng tuần ngay và gửi Telegram
  ['POST', /^\/api\/outlook\/send$/, async (req, res) => {
    const x = await buildOutlook();
    if (telegramConfig().enabled) await sendMessage(formatOutlook(x));
    send(res, 200, x);
  }],
  ['POST', /^\/api\/diagnostics\/run$/, async (req, res) => send(res, 200, await runDiagnosis())],
  // Chụp dữ liệu trong phiên ngay (bỏ qua khung giờ) để kiểm tra
  ['POST', /^\/api\/intraday\/capture$/, async (req, res) => send(res, 200, { rows: await captureIntraday({ force: true }) })],
  // Quét radar ngay (bỏ qua khung giờ) để kiểm tra
  ['POST', /^\/api\/radar\/run$/, async (req, res) => send(res, 200, await radarTick({ force: true }))],
  ['POST', /^\/api\/alerts\/read$/, async (req, res) => {
    await markAlertsRead();
    send(res, 200, { ok: true });
  }],
  // Tự đánh giá: kết quả gần nhất + thông số đang dùng (GET), chạy ngay không áp dụng thay đổi (POST)
  ['GET', /^\/api\/selfreview$/, async (req, res) => send(res, 200, { review: await lastReview(), tuning: getTuning(), log: tuningLog().slice(-20) })],
  ['POST', /^\/api\/selfreview\/run$/, async (req, res) => send(res, 200, await runSelfReview({ apply: false }))],
  // Đồng bộ database ngay
  ['POST', /^\/api\/db\/sync$/, async (req, res) => send(res, 200, await syncAll())],
  // Bản tin Telegram: xem trước (GET) hoặc gửi ngay (POST), ?kind=close|morning|weekly
  ['GET', /^\/api\/telegram\/preview$/, async (req, res) => {
    const k = new URL(req.url, 'http://localhost').searchParams.get('kind');
    const kind = ['morning', 'weekly'].includes(k) ? k : 'close';
    send(res, 200, { kind, ...(await buildReport(kind)) });
  }],
  ['POST', /^\/api\/telegram\/send$/, async (req, res) => {
    if (!telegramConfig().enabled) return send(res, 400, { error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env' });
    const k = new URL(req.url, 'http://localhost').searchParams.get('kind');
    const kind = ['morning', 'weekly'].includes(k) ? k : 'close';
    send(res, 200, await sendReport(kind));
  }],
  ['POST', /^\/api\/alerts\/test$/, async (req, res) => {
    const { symbol, message } = await readBody(req);
    send(res, 200, await triggerTestAlert(symbol, message));
  }],
];

async function serveStatic(req, res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Không tìm thấy' });
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    for (const [method, re, handler] of routes) {
      const m = pathname.match(re);
      if (m && req.method === method) return await handler(req, res, m.slice(1).map(decodeURIComponent));
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'API không tồn tại' });
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`${req.method} ${pathname}:`, err.message);
    const status = /Không tìm thấy/.test(err.message) ? 404
      : /Chưa cấu hình|chỉ áp dụng|không hợp lệ|quá ít dữ liệu/.test(err.message) ? 400
      : /hạn mức/.test(err.message) ? 429 : 502;
    if (!res.headersSent) send(res, status, { error: err.message });
  }
});

// Chỉ lắng nghe trên máy local
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`VN Stock Advisor đang chạy tại http://localhost:${PORT}`);
  console.log(`Tự động quét danh mục mỗi ${SCAN_MINUTES} phút trong giờ giao dịch.`);
  const ai = aiConfig();
  console.log(ai.enabled
    ? `AI: BẬT — thứ tự dự phòng: ${ai.providers.map((p) => `${p.label} (${p.model})`).join(' → ')}${process.env.GEMINI_AUTO_SCAN === '1' ? ' · tự động phân tích danh mục' : ''}`
    : 'AI: TẮT (thêm GEMINI_API_KEY hoặc MISTRAL_API_KEY… vào file .env để bật)');
  startMonitor(SCAN_MINUTES);
  // Chép dữ liệu hằng ngày sang PostgreSQL (docker compose up -d) mỗi 10 phút
  console.log(startDbSync(10)
    ? 'Database: BẬT — đồng bộ dữ liệu sang PostgreSQL mỗi 10 phút (xem tại http://localhost:8081)'
    : 'Database: TẮT (chạy `docker compose up -d` và đặt DB_PASSWORD trong .env)');
  // Sau 15:30 mỗi ngày giao dịch: đối chiếu gợi ý cũ với giá thật, tự chỉnh thông số khi đủ bằng chứng
  startSelfReview(telegramConfig().enabled ? sendMessage : null);
  // Bản tin Telegram sau ATO và sau đóng cửa mỗi ngày giao dịch
  console.log(startTelegramSchedule()
    ? 'Telegram: BẬT — lệnh cho phiên tới 15:10, nhắc lệnh 8:30 (khi có lệnh), tổng kết tuần thứ 6, cảnh báo khẩn mã đang giữ'
    : 'Telegram: TẮT (thêm TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID vào .env, xem `npm run telegram`)');
  // Trong phiên: chụp giá toàn rổ + thị trường vào database; sau 15:45: chẩn đoán lại các dự đoán
  if (startIntraday()) {
    startDiagnose(telegramConfig().enabled ? sendMessage : null);
    console.log(`Thu thập trong phiên: BẬT — mỗi ${INTRADAY_MINUTES} phút (9:15–11:30, 13:00–14:45) vào database; chẩn đoán dự đoán mỗi ngày sau 15:45`);
  }
  // Triển vọng tuần do AI phân tích: gửi Telegram từ 15:45 thứ 6 (bù thứ 7, chủ nhật)
  if (startOutlookSchedule(telegramConfig().enabled ? sendMessage : null)) console.log('Triển vọng tuần (AI): BẬT — gửi Telegram từ 15:45 thứ 6 (bù thứ 7, chủ nhật)');
  // Nhận lệnh từ Telegram: "mua HPG 1000 25.5 21/10" → ghi vào danh mục
  if (startTelegramBot()) console.log('Bot Telegram: BẬT — nhắn "mua/bán MÃ SỐ_LƯỢNG GIÁ [NGÀY]" để ghi danh mục, "danh mục", "hoàn tác"');
  // Quét toàn bộ rổ trong phiên, báo ngay mã nhóm dẫn đầu vừa vào vùng mua (đã qua AI)
  startRadar();
  console.log(`Radar cơ hội mua: BẬT — quét toàn rổ mỗi ${RADAR.minutes} phút (9:30–14:30), lưu trong app${process.env.RADAR_TELEGRAM === '1' ? `, gửi Telegram tối đa ${RADAR.maxDaily} tin/ngày` : ' (Telegram tắt, bật bằng RADAR_TELEGRAM=1)'}`);
  // Mã đang nắm giữ: báo ngay khi thủng / sát cắt lỗ, chạm chốt lời, giảm hoặc tăng mạnh trong phiên
  if (startHoldWatch()) console.log(`Theo dõi danh mục: BẬT — mỗi ${HOLD_RULES.minutes} phút (9:15–14:50): dưới ngưỡng −15%, sát sàn, rủi ro rơi tự do; tối đa ${HOLD_RULES.maxDaily} tin/ngày`);
  // Tải trước bảng top cổ phiếu HOSE để lần mở trang đầu không phải chờ
  getMarketMovers('HOSE').catch(() => {});
  // Tính bảng xếp hạng ngay và mỗi 30 phút (đồng thời ghi top 8 vào nhật ký dự đoán)
  getRankBoard().then(() => getSectorFlows(5)).catch(() => {});
  setInterval(() => getRankBoard().catch(() => {}), 30 * 60_000);
  // Ảnh chụp dữ liệu cuối ngày toàn bộ rổ + ghi dự đoán để tự chấm
  startHistorySchedule();
  // Quét cổ phiếu tiềm năng mỗi ngày giao dịch sau 15:10
  startScreenerSchedule();
  // Tool tự đầu tư (tài khoản giấy): sau 15:10 khớp lệnh phiên vừa chốt ở giá mở cửa, ra lệnh cho phiên tới
  startAutoTradeSchedule();
  console.log('Tool tự đầu tư (tài khoản giấy): BẬT — xử lý mỗi phiên sau 15:10, không đặt lệnh thật');
  // Lưu mua/bán chủ động cả phiên (sau 15:10) cho danh sách theo dõi, danh mục và cổ phiếu tiềm năng
  startFlowCapture(async () => {
    const [w, p, sc] = await Promise.all([getWatchlist().catch(() => []), getPortfolio().catch(() => null), getScreener().catch(() => null)]);
    return [...w.map((x) => x.symbol), ...(p?.holdings || []).map((h) => h.symbol), ...(sc?.result?.candidates || []).map((c) => c.symbol)];
  });
});
