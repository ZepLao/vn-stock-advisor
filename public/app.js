// VN Stock Advisor - Terminal & Testing Suite
// Tích hợp: Phân tích kỹ thuật, Cơ bản BCTC, Tin tức & Tâm lý, Trợ lý AI Gemini,
// Thị trường hôm nay (Movers: Tăng/Giảm & Mua/Bán), Khối ngoại 20 phiên, Thẻ quyết định.

const $ = (id) => document.getElementById(id);
const state = {
  current: null,
  watchlist: [],
  chart: null,
  chartDays: 132,
  newsFilter: 'all',
  activeTab: 'sec-decision',
  wlSort: 'default',
  wlSearch: '',
  movers: null,
  moversTab: 'gainers',
  moversFloor: 'HOSE',
  ai: { enabled: false },
  aiAuto: new Set(),   // mã:phiên đã tự chạy quy trình Gemini + hội đồng (tránh gọi lặp)
  aiRunning: null,     // mã đang chạy quy trình quyết định
  aiError: null,
  cmStage: null,       // bước đang chạy của quy trình, vd "Bước 2/4: Gemini phân tích…"
  cmResult: null,      // kết quả hội đồng gần nhất (có gemini + final) của mã đang xem
  picksTimer: null,
  horizon: 'swing', // swing (5-20P), mid (1-6T), long (1-3N)
};

// Danh mục mã phổ biến hỗ trợ tìm kiếm gợi ý & test ngẫu nhiên
const POPULAR_STOCKS = [
  { symbol: 'VNINDEX', name: 'Chỉ số VN-Index', cat: 'Chỉ số' },
  { symbol: 'FPT', name: 'CTCP FPT', cat: 'Công nghệ' },
  { symbol: 'HPG', name: 'Tập đoàn Hòa Phát', cat: 'Thép' },
  { symbol: 'VCB', name: 'Vietcombank', cat: 'Ngân hàng' },
  { symbol: 'MWG', name: 'Thế Giới Di Động', cat: 'Bán lẻ' },
  { symbol: 'SSI', name: 'Chứng khoán SSI', cat: 'Chứng khoán' },
  { symbol: 'VHM', name: 'Vinhomes', cat: 'BĐS' },
  { symbol: 'VIC', name: 'Tập đoàn Vingroup', cat: 'BĐS' },
  { symbol: 'DGC', name: 'Hóa chất Đức Giang', cat: 'Hóa chất' },
  { symbol: 'TCB', name: 'Techcombank', cat: 'Ngân hàng' },
  { symbol: 'MBB', name: 'Ngân hàng Quân Đội', cat: 'Ngân hàng' },
  { symbol: 'MSN', name: 'Tập đoàn Masan', cat: 'Tiêu dùng' },
  { symbol: 'VNM', name: 'Vinamilk', cat: 'Thực phẩm' },
  { symbol: 'VND', name: 'Chứng khoán VNDIRECT', cat: 'Chứng khoán' },
  { symbol: 'STB', name: 'Sacombank', cat: 'Ngân hàng' },
  { symbol: 'ACB', name: 'Ngân hàng Á Châu', cat: 'Ngân hàng' },
  { symbol: 'GAS', name: 'Tổng công ty Khí VN', cat: 'Dầu khí' },
  { symbol: 'PVD', name: 'Khoan Dầu khí PVD', cat: 'Dầu khí' },
  { symbol: 'KBC', name: 'Kinh Bắc City', cat: 'KCN' },
  { symbol: 'VRE', name: 'Vincom Retail', cat: 'Bán lẻ' },
];

// ==========================================================================
// 20-YEAR VETERAN TRADING ENGINE EXTENSIONS (CHƯƠNG 1, 7, 9, 12)
// ==========================================================================

// 20 nguyên tắc đầu tư & kỷ luật rủi ro
const RULES_20 = [
  {
    group: '1. Tâm lý, Kỷ luật & Bảo toàn vốn',
    items: [
      { num: 1, text: '<strong>Bảo vệ vốn là ưu tiên số một:</strong> còn tiền là còn cơ hội, mất tiền là mất tất cả.' },
      { num: 2, text: '<strong>Có ngưỡng thoát và tuân thủ nó:</strong> đóng cửa dưới −15% giá vốn là bán, không bình quân giá xuống. Ngưỡng xa có chủ ý: trên HOSE, cắt sát −5% đến −7% bị rung lắc hất ra nhiều hơn và làm lãi giảm (bộ đo 4 năm).' },
      { num: 3, text: '<strong>Không yêu cổ phiếu:</strong> cổ phiếu chỉ là công cụ sinh lời, gãy xu hướng là bán không nuối tiếc.' },
      { num: 4, text: '<strong>Đừng cố đoán đỉnh/đáy:</strong> mua khi có xác nhận xu hướng tăng, bán khi có tín hiệu suy yếu đảo chiều.' },
    ]
  },
  {
    group: '2. Quản trị điểm vào, Quy mô vốn & Kim tự tháp',
    items: [
      { num: 5, text: '<strong>Không bình quân giá xuống khi đang lỗ:</strong> chỉ gia tăng vị thế khi lệnh đầu tiên đã sinh lời (≥ +3%).' },
      { num: 6, text: '<strong>Điểm mua quyết định điểm bán:</strong> vào ở điểm rủi ro thấp (gần hỗ trợ/Pivot) thì điểm cắt lỗ sẽ rất ngắn và an toàn.' },
      { num: 7, text: '<strong>Lãi lớn đến từ việc ngồi yên:</strong> kiên nhẫn để cổ phiếu chạy hết sóng lớn, đừng chốt non vì rung lắc ngắn hạn.' },
      { num: 8, text: '<strong>Phản ứng quan trọng hơn dự đoán:</strong> thị trường luôn đúng; khi giá chạy ngược kịch bản, hành động theo kỷ luật ngay.' },
    ]
  },
  {
    group: '3. Thị trường chung, Chu kỳ T+2 & Margin',
    items: [
      { num: 9, text: '<strong>Đám đông hưng phấn nhất là gần đỉnh;</strong> hoảng loạn cùng cực nhất thường là gần đáy chu kỳ.' },
      { num: 10, text: '<strong>Margin khuếch đại cả sai lầm:</strong> chỉ dùng đòn bẩy khi thị trường chung và cổ phiếu đều thuận lợi.' },
      { num: 11, text: '<strong>Tiền mặt là một vị thế mạnh:</strong> đứng ngoài cầm tiền trong thị trường downtrend/phân phối là đã chiến thắng.' },
      { num: 12, text: '<strong>Đa dạng hóa vừa đủ (5–10 mã):</strong> không dồn tất tay 1 mã, cũng không dàn trải quá 15-30 mã làm mất kiểm soát.' },
      { num: 13, text: '<strong>Tránh xa cổ phiếu thanh khoản thấp/cổ rác:</strong> thanh khoản cạn kiệt thì vào dễ nhưng khi sập sẽ trắng bên mua.' },
      { num: 14, text: '<strong>Luôn tính đến rủi ro kẹt hàng T+2 và biên độ trần/sàn:</strong> đảm bảo dự phòng rủi ro biến cố bất ngờ.' },
    ]
  },
  {
    group: '4. Kiểm định dữ liệu, BCTC & Tự điều chỉnh',
    items: [
      { num: 15, text: '<strong>Không mua sát ngày công bố BCTC</strong> nếu chưa có lợi thế biên an toàn hoặc tin tức xác nhận rõ ràng.' },
      { num: 16, text: '<strong>Theo dõi hành động của lãnh đạo doanh nghiệp:</strong> nhìn dòng tiền thực tế và giao dịch nội bộ, không tin lời hứa.' },
      { num: 17, text: '<strong>Ghi nhật ký mọi lệnh:</strong> sai lầm lặp lại mà không sửa chữa là khoản lỗ đắt đỏ nhất của nhà đầu tư.' },
      { num: 18, text: '<strong>Một chiến lược chỉ đáng tin</strong> khi đã được kiểm chứng sống sót qua cả thị trường tăng (Bull) lẫn giảm (Bear).' },
      { num: 19, text: '<strong>Không tùy tiện sửa quy tắc giữa chừng</strong> chỉ vì 1–2 lệnh thua ngẫu nhiên; đánh giá hiệu quả trên mẫu đủ lớn.' },
      { num: 20, text: '<strong>Tool là trợ lý phân tích, không phải thầy bói:</strong> người ra quyết định cuối cùng và chịu trách nhiệm là chính bạn!' },
    ]
  }
];

function setupRulesModal() {
  const modal = $('modal-20-rules');
  const openBtn = $('btn-20-rules');
  const closeBtn = $('close-20-rules');
  const list = $('rules-20-list');

  if (list && !list.children.length) {
    list.innerHTML = RULES_20.map((grp) => 
      '<div class="rule-group">' +
        '<div class="rule-group-title">' + esc(grp.group) + '</div>' +
        grp.items.map((it) => 
          '<label class="rule-item">' +
            '<input type="checkbox" data-rule="' + it.num + '">' +
            '<span class="rule-num">#' + (it.num < 10 ? '0' + it.num : it.num) + '</span>' +
            '<div class="rule-text">' + it.text + '</div>' +
          '</label>'
        ).join('') +
      '</div>'
    ).join('');
  }

  openBtn?.addEventListener('click', () => {
    if (modal) modal.hidden = false;
  });
  closeBtn?.addEventListener('click', () => {
    if (modal) modal.hidden = true;
  });
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

function renderCapitalOverview(p) {
  const c = p.capital || {};
  const s = p.summary || {};
  const nav = c.nav || ((s.marketValue || 0) + (c.cash || 0)) || 5000000;
  const netContributed = c.netContributed || c.deposits || nav;
  const cash = c.remainingCash || c.cash || 0;
  const available = c.available ?? cash;
  const pendingSale = c.pendingSale || 0;
  const stockVal = c.stockValue || (s.marketValue || 0);
  const stockPct = nav > 0 ? ((stockVal / nav) * 100) : 0;
  const cashPct = nav > 0 ? ((cash / nav) * 100) : 0;
  const totalPnl = c.totalPnl ?? (nav - netContributed);
  const totalPnlPct = netContributed > 0 ? ((totalPnl / netContributed) * 100) : 0;
  
  return `
    <section class="card capital-overview-card">
      <div class="card-head">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <h3 style="margin:0;font-size:16px;font-weight:800;color:var(--ink)">💰 BỨC TRANH TÀI SẢN &amp; QUẢN TRỊ VỐN (NAV &amp; SỨC MUA)</h3>
          <span class="badge-subtle" style="color:var(--accent);border-color:rgba(59,130,246,0.3)">Kỷ luật 20 năm: Bảo toàn vốn là số 1</span>
        </div>
      </div>
      
      <div class="cap-stat-grid">
        <div class="cap-stat-item primary">
          <div class="cap-stat-label">Tổng tài sản (NAV)</div>
          <div class="cap-stat-val">${money(nav)}</div>
          <div class="cap-stat-sub">${Math.round(nav).toLocaleString('vi-VN')} đ</div>
        </div>
        <div class="cap-stat-item">
          <div class="cap-stat-label">Vốn thực nạp ròng</div>
          <div class="cap-stat-val">${money(netContributed)}</div>
          <div class="cap-stat-sub">${Math.round(netContributed).toLocaleString('vi-VN')} đ</div>
        </div>
        <div class="cap-stat-item ${totalPnl >= 0 ? 'up' : 'down'}">
          <div class="cap-stat-label">Hiệu quả ròng so với vốn</div>
          <div class="cap-stat-val ${totalPnl >= 0 ? 'up' : 'down'}">${totalPnl >= 0 ? '+' : ''}${money(totalPnl)}</div>
          <div class="cap-stat-sub ${totalPnl >= 0 ? 'up' : 'down'}">${totalPnl >= 0 ? '+' : ''}${totalPnlPct.toFixed(2)}%</div>
        </div>
        <div class="cap-stat-item">
          <div class="cap-stat-label">Tiền mặt khả dụng (Sức mua)</div>
          <div class="cap-stat-val ${available > 0 ? 'up' : 'muted'}">${money(available)}</div>
          <div class="cap-stat-sub">Giải ngân được ngay</div>
        </div>
        <div class="cap-stat-item">
          <div class="cap-stat-label">Tiền bán T+2 chờ về</div>
          <div class="cap-stat-val">${money(pendingSale)}</div>
          <div class="cap-stat-sub">Đang trong chu kỳ bù trừ T+2</div>
        </div>
        <div class="cap-stat-item">
          <div class="cap-stat-label">Giá trị cổ phiếu đang giữ</div>
          <div class="cap-stat-val">${money(stockVal)}</div>
          <div class="cap-stat-sub">${s.positions || 0} mã đang mở vị thế</div>
        </div>
      </div>

      <div class="cap-alloc-wrap">
        <div class="cap-alloc-labels">
          <span><b>Cơ cấu tài sản:</b> Cổ phiếu <b>${stockPct.toFixed(1)}%</b> · Tiền mặt <b>${cashPct.toFixed(1)}%</b></span>
          <span class="muted small">${stockPct > 80 ? '⚠️ Tỷ trọng cổ phiếu cao (>80%) - Cần thị trường Uptrend xác nhận' : '✅ Tỷ trọng phân bổ an toàn'}</span>
        </div>
        <div class="cap-alloc-bar">
          <div class="bar-stock" style="width: ${Math.min(100, Math.max(0, stockPct))}%" title="Cổ phiếu: ${stockPct.toFixed(1)}%"></div>
          <div class="bar-cash" style="width: ${Math.min(100, Math.max(0, cashPct))}%" title="Tiền mặt: ${cashPct.toFixed(1)}%"></div>
        </div>
      </div>
    </section>
  `;
}

function renderPortfolioHeat(p) {
  const holdings = p.holdings || [];
  const s = p.summary || {};
  const totalCost = holdings.reduce((sum, h) => sum + (h.cost || (h.avgCost * h.qty * 1000)), 0);
  const nav = s.nav || (totalCost + (s.cash || 0)) || 100000000;
  
  let totalRiskAmount = 0;
  holdings.forEach(h => {
    const stop = h.effectiveStop || h.avgCost * 0.85; // rủi ro nếu giữ đến ngưỡng thoát −15%
    const riskPerShare = Math.max(0, (h.avgCost - stop) * 1000);
    totalRiskAmount += riskPerShare * h.qty;
  });
  
  const heatPct = Math.min(25, (totalRiskAmount / nav) * 100);
  const heatTone = heatPct <= 6 ? 'safe' : heatPct <= 8 ? 'caution' : 'danger';
  const heatLabel = heatPct <= 6 ? 'AN TOÀN (≤ 6% NAV)' : heatPct <= 8 ? 'NGƯỠNG TỐI ĐA (6% - 8% NAV)' : 'CẢNH BÁO QUÁ NHIỆT (> 8% NAV)';
  
  const mdd = p.risk?.maxDrawdown != null ? Math.abs(p.risk.maxDrawdown * 100) : 0;
  const cbStatus = mdd >= 15 
    ? { title: '🛑 ĐÓNG BĂNG GIAO DỊCH 1 TUẦN', tone: 'danger', desc: 'Danh mục sụt giảm ≥ 15% từ đỉnh. Dừng mở lệnh mới.' }
    : mdd >= 10
    ? { title: '⚠️ GIẢM 50% QUY MÔ LỆNH', tone: 'caution', desc: 'Danh mục sụt giảm ≥ 10% từ đỉnh. Hạ một nửa tỷ trọng mở mới.' }
    : { title: '✅ 100% CÔNG SUẤT BÌNH THƯỜNG', tone: 'safe', desc: 'Sụt giảm danh mục trong tầm kiểm soát (< 10%).' };

  return `
    <div class="card portfolio-heat-card">
      <div class="card-head">
        <div>
          <h3 style="font-size:14px; font-weight:800">🌡️ NHIỆT ĐỘ RỦI RO &amp; CẦU DAO BẢO TOÀN VỐN (CHƯƠNG 9)</h3>
          <div class="muted small">Giới hạn tổng rủi ro mở và cơ chế tự động ngắt mạch drawdown danh mục</div>
        </div>
        <span class="badge ${heatTone === 'safe' ? 'badge-up' : heatTone === 'caution' ? 'badge-ref' : 'badge-down'}">${heatLabel}</span>
      </div>

      <div class="heat-meter-wrap">
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px">
          <span>Tổng rủi ro đang gánh (Portfolio Heat): <b>${heatPct.toFixed(1)}% NAV</b></span>
          <span class="muted">Mức trần cho phép: 6.0% – 8.0% NAV</span>
        </div>
        <div class="heat-meter-bar">
          <div class="heat-meter-fill ${heatTone}" style="width:${Math.min(100, (heatPct / 10) * 100)}%"></div>
        </div>
        <div class="heat-labels">
          <span>0%</span>
          <span>Ngưỡng an toàn: 6%</span>
          <span>Trần tối đa: 8%</span>
          <span>10%+</span>
        </div>
      </div>

      <div class="cb-grid">
        <div class="cb-box">
          <span class="cb-head">Trạng thái Cầu dao (Circuit Breaker)</span>
          <span class="cb-status ${cbStatus.tone === 'safe' ? 'up' : 'down'}">${cbStatus.title}</span>
          <span class="cb-desc">${cbStatus.desc}</span>
        </div>
        <div class="cb-box">
          <span class="cb-head">Quy tắc Chuỗi thua liên tiếp</span>
          <span class="cb-status up">GIẢM 50% SIZE NẾU THUA 3 LỆNH</span>
          <span class="cb-desc">Sau 3 lệnh thua liên tiếp, tự động giảm nửa volume để phòng thủ tâm lý.</span>
        </div>
        <div class="cb-box">
          <span class="cb-head">Giới hạn Mã &amp; Suất vốn</span>
          <span class="cb-status up">5–10 MÃ · TỐI ĐA 3 MÃ/NGÀNH</span>
          <span class="cb-desc">Không dàn trải quá 10 mã, không tập trung quá 35% vốn vào một nhóm ngành.</span>
        </div>
      </div>
    </div>
  `;
}


// ---------- Tiện ích cơ bản ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const fmtPct = (v, d = 1) => (v == null ? '–' : `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: d })}%`);
const signed = (v, d = 2) => (v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, d)}`);
const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'ref');
const fmtBig = (v) => {
  if (v == null) return '–';
  if (Math.abs(v) >= 1e12) return `${fmt(v / 1e12, 1)} nghìn tỷ`;
  if (Math.abs(v) >= 1e9) return `${fmt(v / 1e9, 1)} tỷ`;
  if (Math.abs(v) >= 1e6) return `${fmt(v / 1e6, 1)} triệu`;
  return fmt(v, 0);
};
const timeAgo = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m} phút trước`;
  if (m < 1440) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
};

// Toast notification helper
function showToast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span style="font-weight:700">${icon}</span> <span>${esc(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

// ---------- Giao diện sáng / tối ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('vnstock_theme'); } catch {}
  if (!saved) saved = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  applyTheme(saved);

  $('theme-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vnstock_theme', theme);
  const isDark = theme === 'dark';
  $('theme-moon').hidden = !isDark;
  $('theme-sun').hidden = isDark;
  if (state.current) {
    renderChart(state.current);
    renderForeignChart(state.current);
  }
}

// ---------- Thị trường (VN-Index) ----------
async function loadMarket() {
  const el = $('market');
  if (!el) return;
  const renderM = (m) => {
    const trend = { up: 'tăng', down: 'giảm', sideways: 'đi ngang' }[m.trend] || m.trend;
    el.innerHTML = `
      <span class="market-live-dot ${m.change >= 0 ? '' : 'down'}"></span>
      <span class="market-content">VN-Index <b>${fmt(m.close)}</b> <span class="${dirClass(m.change)}">${signed(m.change)} (${signed(m.changePct)}%)</span> · <span class="muted">${trend}</span></span>
    `;
    el.onclick = () => analyze('VNINDEX');
  };
  try {
    const cached = sessionStorage.getItem('last_market');
    if (cached) renderM(JSON.parse(cached));
  } catch {}
  try {
    const m = await api('/api/market');
    renderM(m);
    try { sessionStorage.setItem('last_market', JSON.stringify(m)); } catch {}
  } catch {
    if (!sessionStorage.getItem('last_market')) {
      el.innerHTML = `<span class="market-content muted">Chưa tải được VN-Index</span>`;
    }
  }
}

// ---------- Chế độ thị trường & Tỷ trọng danh mục ----------
async function loadMarketRegime() {
  const el = $('market-regime-pill');
  if (!el) return;

  const updateUi = (r) => {
    const dot = $('regime-dot');
    const content = $('regime-content');
    if (dot) dot.style.background = r.color || '#10b981';
    const tag = r.regime === 'CONFIRMED_UPTREND' ? '🟢 TĂNG MẠNH' : (r.regime === 'UPTREND_UNDER_PRESSURE' ? '🟡 ÁP LỰC' : r.regime === 'UNKNOWN' ? '⚪ CHƯA RÕ' : '🔴 RỦI RO');
    if (content) {
      content.innerHTML = `<b>${tag}</b> · Phân phối: <b>${r.distDays ?? '–'}</b>/25 · CP: <b>${r.exposure}</b>`;
    }
    el.title = `Chế độ: ${r.label}\nSố ngày phân phối 25 phiên: ${r.distDays}\nTỷ trọng cổ phiếu khuyến nghị: ${r.exposure}\n${r.desc}`;
    el.onclick = () => {
      showToast(`${r.label}: Phân phối ${r.distDays}/25 phiên · Tỷ trọng CP: ${r.exposure} · ${r.desc}`, 'info', 5000);
    };
  };

  try {
    const cachedStr = sessionStorage.getItem('last_market_regime');
    if (cachedStr) {
      updateUi(JSON.parse(cachedStr));
    }
  } catch { /* bỏ qua lỗi sessionStorage */ }

  try {
    const r = await api('/api/market-regime');
    updateUi(r);
    try { sessionStorage.setItem('last_market_regime', JSON.stringify(r)); } catch {}
  } catch {
    if (!$('regime-content')?.innerHTML?.includes('b>')) {
      if ($('regime-content')) $('regime-content').textContent = 'Chế độ TT: –';
    }
  }
}

// ---------- THỊ TRƯỜNG HÔM NAY: TĂNG / GIẢM & KHỐI NGOẠI MUA / BÁN (MOVERS) ----------
async function loadMovers(floor = state.moversFloor) {
  if (state.movers && state.movers.floor === floor) {
    renderMovers();
  } else {
    try {
      const cached = sessionStorage.getItem(`last_movers_${floor}`);
      if (cached) {
        state.movers = JSON.parse(cached);
        renderMovers();
      }
    } catch {}
  }
  try {
    const data = await api(`/api/movers?floor=${encodeURIComponent(floor)}`);
    state.movers = data;
    renderMovers();
    try { sessionStorage.setItem(`last_movers_${floor}`, JSON.stringify(data)); } catch {}
  } catch (err) {
    if (!state.movers) {
      const el = $('movers-list');
      if (el) el.innerHTML = `<div class="movers-empty">Không tải được số liệu sàn ${esc(floor)}: ${esc(err.message)}</div>`;
    }
  }
}

function renderMovers() {
  const el = $('movers-list');
  if (!el) return;
  const data = state.movers;
  if (!data) {
    el.innerHTML = '<div class="movers-empty">Đang cập nhật dữ liệu thị trường…</div>';
    return;
  }
  const tab = state.moversTab || 'gainers';
  let list = [];
  if (tab === 'gainers') list = data.gainers || [];
  else if (tab === 'losers') list = data.losers || [];
  else if (tab === 'fBuy') list = data.foreignBuy || [];
  else if (tab === 'fSell') list = data.foreignSell || [];
  else if (tab === 'value') list = data.topValue || [];

  if (!list.length) {
    el.innerHTML = '<div class="movers-empty">Chưa có dữ liệu cho mục này</div>';
    return;
  }

  const maxVal = Math.max(...list.map((item) => {
    if (tab === 'gainers' || tab === 'losers') return Math.abs(item.changePct);
    if (tab === 'fBuy' || tab === 'fSell') return Math.abs(item.netVal || 0);
    return item.value || 0;
  }), 1);

  el.innerHTML = list.slice(0, 10).map((s, idx) => {
    let mainVal = '', barCls = 'pos', barWidth = 0, subTxt = '';
    if (tab === 'gainers') {
      mainVal = `<span class="up num">+${s.changePct.toFixed(1)}%</span>`;
      barCls = 'pos';
      barWidth = Math.min(100, (s.changePct / maxVal) * 100);
      subTxt = `${fmtBig(s.value)} đ`;
    } else if (tab === 'losers') {
      mainVal = `<span class="down num">${s.changePct.toFixed(1)}%</span>`;
      barCls = 'neg';
      barWidth = Math.min(100, (Math.abs(s.changePct) / maxVal) * 100);
      subTxt = `${fmtBig(s.value)} đ`;
    } else if (tab === 'fBuy') {
      mainVal = `<span class="up num">+${fmt(s.netVal / 1e9, 1)} tỷ</span>`;
      barCls = 'pos';
      barWidth = Math.min(100, (s.netVal / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    } else if (tab === 'fSell') {
      mainVal = `<span class="down num">${fmt(s.netVal / 1e9, 1)} tỷ</span>`;
      barCls = 'neg';
      barWidth = Math.min(100, (Math.abs(s.netVal) / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    } else {
      mainVal = `<span class="num">${fmtBig(s.value)} đ</span>`;
      barCls = s.changePct > 0 ? 'pos' : s.changePct < 0 ? 'neg' : 'neu';
      barWidth = Math.min(100, (s.value / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    }

    return `
      <div class="mv-row" data-sym="${esc(s.symbol)}">
        <span class="mv-rank ${idx < 3 ? `top-${idx + 1}` : ''}">${idx + 1}</span>
        <div class="mv-sym-col">
          <span class="mv-sym">${esc(s.symbol)}</span>
          <span class="mv-price">${fmt(s.close)}</span>
        </div>
        <div class="mv-val-col">
          <div class="mv-val">${mainVal}</div>
          <div class="mv-sub">${subTxt}</div>
        </div>
        <div class="mv-bar-wrap"><i class="mv-bar-fill ${barCls}" style="width:${barWidth}%"></i></div>
      </div>
    `;
  }).join('');
}

// Bắt sự kiện chọn sàn và tab trên Movers
$('movers-floor')?.addEventListener('change', (e) => {
  state.moversFloor = e.target.value;
  loadMovers(state.moversFloor);
});

$('movers-tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-filter');
  if (!btn) return;
  document.querySelectorAll('#movers-tabs .btn-filter').forEach((b) => {
    b.classList.remove('on');
    b.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('on');
  btn.setAttribute('aria-selected', 'true');
  state.moversTab = btn.dataset.tab;
  renderMovers();
});

$('movers-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-sym]');
  if (row) analyze(row.dataset.sym);
});

// ---------- Danh mục theo dõi ----------
async function loadWatchlist() {
  state.watchlist = await api('/api/watchlist').catch(() => []);
  if ($('wl-count')) $('wl-count').textContent = state.watchlist.length;
  if ($('wl-count-tab')) $('wl-count-tab').textContent = state.watchlist.length;
  if ($('mb-wl-count')) $('mb-wl-count').textContent = state.watchlist.length;
  renderWatchlist();
  // Lần đầu mở trang mà chưa theo dõi mã nào: hiện sẵn tab Thị trường thay vì một danh sách trống
  if (!state.sideChosen && !state.watchlist.length && window.innerWidth >= 1024) $('side-tab-movers')?.click();
  state.sideChosen = true;
}

function renderWatchlist() {
  const el = $('watchlist');
  let list = [...state.watchlist];

  if (state.wlSearch) {
    const q = state.wlSearch.toLowerCase();
    list = list.filter((w) => w.symbol.toLowerCase().includes(q) || (w.note && w.note.toLowerCase().includes(q)));
  }

  if (state.wlSort === 'score') {
    list.sort((a, b) => (b.snapshot?.total ?? -999) - (a.snapshot?.total ?? -999));
  } else if (state.wlSort === 'change') {
    list.sort((a, b) => (b.snapshot?.price?.changePct ?? -999) - (a.snapshot?.price?.changePct ?? -999));
  }

  if (!list.length) {
    el.innerHTML = state.wlSearch
      ? '<p class="muted small" style="padding:10px">Không tìm thấy mã phù hợp.</p>'
      : '<p class="muted small" style="padding:10px">Chưa có mã nào. Bấm vào một mã kiểm thử hoặc nhập mã để thêm.</p>';
    return;
  }

  el.innerHTML = list.map((w) => {
    const s = w.snapshot;
    const isBuy = s?.recommendation?.code === 'BUY' || s?.recommendation?.code === 'ACCUMULATE';
    const isHold = s?.recommendation?.code === 'HOLD';
    const isSell = s?.recommendation?.code === 'SELL' || s?.recommendation?.code === 'AVOID';
    const rowClass = isBuy ? 'is-buy' : isHold ? 'is-hold' : isSell ? 'is-sell' : '';

    const tpBadge = s?.trendPick ? '<span class="st-badge up" style="font-size:9px;padding:1px 4px;margin-left:4px" title="Trend Pick 8 năm">★ TP</span>' : '';
    const riskBadge = s?.stockRisk ? '<span class="st-badge down" style="font-size:9px;padding:1px 4px;margin-left:4px" title="Cảnh báo rủi ro cao">🚨 RỦI RO</span>' : '';
    // Một quyết định duy nhất: quyết định cuối (hệ thống + AI) nếu có cho phiên này, không thì khuyến nghị hệ thống.
    // Bỏ điểm kiểu cũ và tín hiệu Monte Carlo (không dự báo được hướng) khỏi dòng tóm tắt.
    const fin = w.ai?.final && w.ai.priceDate === s?.price?.date ? w.ai.final : null;
    const rec = fin ? { code: fin.code, label: fin.label } : s?.recommendation;
    const meta = s
      ? `<span class="rec-txt ${recColor(rec.code)}">${esc(rec.label)}</span>${fin ? ' <span class="muted small">(có AI)</span>' : ''}${s.rankScore != null ? ` · <span class="num">xếp hạng ${s.rankScore}</span>` : ''}${s.warnings ? ' · ⚠' : ''}`
      : 'Đang chờ quét…';
    const aiTxt = '';
    const alertTxt = [w.priceAbove != null && `≥${w.priceAbove}`, w.priceBelow != null && `≤${w.priceBelow}`].filter(Boolean).join(' ');

    return `
      <div class="wl-row ${rowClass} ${state.current?.symbol === w.symbol ? 'active' : ''}" data-sym="${esc(w.symbol)}">
        <span class="wl-sym">${esc(w.symbol)}${tpBadge}${riskBadge}</span>
        <span class="wl-price">${s ? `${fmt(s.price.close)} <span class="wl-pct-pill ${dirClass(s.price.change)}">${signed(s.price.changePct)}%</span>` : ''}</span>
        <button class="wl-del" data-del="${esc(w.symbol)}" title="Bỏ theo dõi" aria-label="Bỏ theo dõi ${esc(w.symbol)}">✕</button>
        <span class="wl-meta">${meta}${aiTxt}${alertTxt ? ` · 🔔 ${esc(alertTxt)}` : ''}</span>
      </div>
    `;
  }).join('');
}

function recColor(code) {
  return { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down' }[code] || '';
}

function aiColor(code) {
  return { MUA: 'up', MUA_THAM_DO: 'up', GIU: 'ref', DUNG_NGOAI: 'down', BAN_BOT: 'down', BAN: 'down' }[code] || '';
}

$('watchlist').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const sym = del.dataset.del;
    await api(`/api/watchlist/${sym}`, { method: 'DELETE' });
    showToast(`Đã xóa ${sym} khỏi danh mục`, 'info');
    await loadWatchlist();
    updateWatchButton();
    return;
  }
  const row = e.target.closest('[data-sym]');
  if (row) analyze(row.dataset.sym);
});

$('wl-search')?.addEventListener('input', (e) => {
  state.wlSearch = e.target.value.trim();
  renderWatchlist();
});

document.querySelectorAll('.wl-sort-btns .btn-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wl-sort-btns .btn-filter').forEach((b) => {
      b.classList.remove('on');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('on');
    btn.setAttribute('aria-pressed', 'true');
    state.wlSort = btn.dataset.sort;
    renderWatchlist();
  });
});

$('quick-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('quick-add-input');
  const sym = input.value.trim().toUpperCase();
  if (!sym) return;
  try {
    await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
    input.value = '';
    showToast(`Đã thêm ${sym} vào danh mục`, 'success');
    await loadWatchlist();
    updateWatchButton();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('scan-btn').addEventListener('click', async () => {
  const btn = $('scan-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Đang quét…';
  try {
    await api('/api/scan', { method: 'POST' });
    await Promise.all([loadWatchlist(), loadAlerts(), loadMovers()]);
    showToast('Đã quét và cập nhật toàn bộ danh mục thành công!', 'success');
  } catch (err) {
    showToast(`Lỗi quét: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Quét lại';
  }
});

// ---------- Tìm kiếm & Gợi ý (Autocomplete) ----------
const searchInput = $('search-input');
const searchSuggestions = $('search-suggestions');
const searchClearBtn = $('search-clear-btn');

function renderSearchSuggestions(query = '') {
  const q = query.trim().toUpperCase();
  const filtered = POPULAR_STOCKS.filter((s) => s.symbol.includes(q) || s.name.toUpperCase().includes(q));
  if (!filtered.length) {
    searchSuggestions.hidden = true;
    return;
  }
  searchSuggestions.innerHTML = filtered.map((s) => `
    <div class="search-item" data-sym="${esc(s.symbol)}">
      <div class="search-item-left">
        <span class="search-item-sym">${esc(s.symbol)}</span>
        <span class="search-item-name">${esc(s.name)}</span>
      </div>
      <span class="search-item-cat">${esc(s.cat)}</span>
    </div>
  `).join('');
  searchSuggestions.hidden = false;
}

searchInput?.addEventListener('focus', () => renderSearchSuggestions(searchInput.value));
searchInput?.addEventListener('input', () => {
  searchClearBtn.hidden = !searchInput.value;
  renderSearchSuggestions(searchInput.value);
});

searchClearBtn?.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.hidden = true;
  searchSuggestions.hidden = true;
  searchInput.focus();
});

searchSuggestions?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-sym]');
  if (item) {
    searchSuggestions.hidden = true;
    analyze(item.dataset.sym);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-container')) {
    searchSuggestions.hidden = true;
  }
});

$('search')?.addEventListener('submit', (e) => {
  e.preventDefault();
  searchSuggestions.hidden = true;
  const sym = searchInput.value.trim().toUpperCase();
  if (sym) analyze(sym);
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
    return;
  }
  if (e.key === 'Escape') {
    const rulesModal = $('modal-20-rules');
    if (rulesModal && !rulesModal.hidden) {
      rulesModal.hidden = true;
      return;
    }
    const drawer = $('drawer');
    if (drawer && !drawer.hidden) {
      drawer.hidden = true;
      return;
    }
    const sheet = $('mobile-more-sheet');
    if (sheet && !sheet.hidden) {
      sheet.hidden = true;
      return;
    }
    if (searchSuggestions && !searchSuggestions.hidden) {
      searchSuggestions.hidden = true;
      return;
    }
  }
});

// Random stock test button
function runRandomStock() {
  const pool = POPULAR_STOCKS.filter((s) => s.symbol !== state.current?.symbol && s.symbol !== 'VNINDEX');
  const picked = pool[Math.floor(Math.random() * pool.length)];
  if (picked) {
    showToast(`Đang test mã ngẫu nhiên: ${picked.symbol} (${picked.name})`, 'info');
    analyze(picked.symbol);
  }
}

$('btn-random-stock')?.addEventListener('click', () => {
  $('tools-dropdown')?.classList.remove('open');
  runRandomStock();
});
$('btn-ribbon-random')?.addEventListener('click', runRandomStock);

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-sym]');
  if (chip && !chip.closest('#watchlist') && !chip.closest('#alerts-list') && !chip.closest('.search-dropdown') && !chip.closest('#movers-list')) {
    analyze(chip.dataset.sym);
  }
});

async function analyze(symbol) {
  symbol = symbol.toUpperCase();
  if (typeof setMobileTab === 'function') setMobileTab('analyze');
  if ($('mobile-back-sym')) $('mobile-back-sym').textContent = symbol;
  searchInput.value = symbol;
  searchClearBtn.hidden = false;

  document.querySelectorAll('.ticker-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.sym === symbol);
  });
  document.querySelectorAll('#scan-results-body tr').forEach((tr) => {
    tr.classList.toggle('is-active-sym', tr.dataset.sym === symbol);
  });

  $('empty').hidden = true;
  $('error').hidden = true;
  $('report').hidden = true;
  $('picks').hidden = true;
  $('picks-btn')?.classList.remove('on');
  $('portfolio').hidden = true;
  $('pf-btn')?.classList.remove('on');
  $('rankview').hidden = true;
  $('rank-btn')?.classList.remove('on');
  $('sectorview').hidden = true;
  $('sector-btn')?.classList.remove('on');
  $('autoview').hidden = true;
  $('auto-btn')?.classList.remove('on');
  $('marketview').hidden = true;
  $('loading').hidden = false;
  $('loading-msg').textContent = `Đang phân tích ${symbol}…`;
  history.replaceState(null, '', `#${symbol}`);

  try {
    const a = await api(`/api/analyze/${encodeURIComponent(symbol)}`);
    state.current = a;
    $('loading').hidden = true;
    $('report').hidden = false;
    render(a);
    renderWatchlist();
  } catch (err) {
    $('loading').hidden = true;
    console.error('ANALYZE ERROR:', err.stack); $('error-msg').textContent = err.stack || err.message;
    $('error').hidden = false;
  }
}

$('r-warnings')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-warn-toggle]');
  if (!b) return;
  const card = b.closest('.warn-card');
  card.classList.toggle('open');
  b.textContent = card.classList.contains('open') ? 'Thu gọn' : `Xem cả ${card.querySelectorAll('.warn-list li').length}`;
});

$('error-retry')?.addEventListener('click', () => {
  if (state.current?.symbol) analyze(state.current.symbol);
});

// ---------- Thanh mục của trang phân tích: mọi mục luôn hiện, bấm để cuộn tới ----------
function initTabs() {
  const nav = $('report-nav');
  if (!nav) return;
  const mark = (id) => nav.querySelectorAll('.nav-tab').forEach((t) => {
    const on = t.dataset.target === id;
    t.classList.toggle('on', on);
    if (on && !t.classList.contains('was-on')) nav.scrollTo({ left: t.offsetLeft - (nav.clientWidth - t.offsetWidth) / 2, behavior: 'smooth' });
    t.classList.toggle('was-on', on);
  });
  let lock = 0;
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    const sec = $(tab.dataset.target);
    if (!sec) return;
    mark(tab.dataset.target);
    lock = Date.now() + 800; // trong lúc cuộn mượt, không để theo dõi cuộn đổi mục đang chọn
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  // Mục đang xem: mục cuối cùng có đầu mục đã cuộn qua ngay dưới thanh mục
  const secs = [...document.querySelectorAll('.report-section')];
  let queued = false;
  const spy = () => {
    queued = false;
    if (Date.now() < lock || $('report').hidden) return;
    const line = nav.getBoundingClientRect().bottom + 90;
    let cur = secs[0];
    for (const sec of secs) if (sec.offsetParent !== null && sec.getBoundingClientRect().top <= line) cur = sec;
    // Đã cuộn hết trang: mục cuối không thể lên tới thanh mục, coi mục thấp nhất đang hiện là mục đang xem
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) cur = secs.filter((x) => x.offsetParent !== null && x.getBoundingClientRect().top < innerHeight).at(-1) || cur;
    if (cur) mark(cur.id);
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
}
initTabs();

// ---------- Chế độ trang: danh sách mã bên trái chỉ có ở trang phân tích mã, và ẩn/hiện được ----------
const PAGE_OF = { marketview: 'market', report: 'stock', empty: 'stock', loading: 'stock', error: 'stock', picks: 'picks', sectorview: 'sector', rankview: 'rank', portfolio: 'portfolio', autoview: 'auto' };
function syncPage() {
  const id = Object.keys(PAGE_OF).find((k) => $(k) && !$(k).hidden);
  document.body.dataset.page = PAGE_OF[id] || 'stock';
  $('mk-btn')?.classList.toggle('on', id === 'marketview');
}
const pageObserver = new MutationObserver(syncPage);
Object.keys(PAGE_OF).forEach((k) => $(k) && pageObserver.observe($(k), { attributes: true, attributeFilter: ['hidden'] }));
syncPage();

function setSide(on) {
  document.body.dataset.side = on ? 'on' : 'off';
  $('side-toggle')?.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('vnstock_side', on ? 'on' : 'off'); } catch { /* bỏ qua */ }
  // Biểu đồ đổi bề rộng: canh lại khung nhìn
  requestAnimationFrame(() => { if (state.chart) setRange(state.chartDays); });
}
setSide((() => { try { return localStorage.getItem('vnstock_side') !== 'off'; } catch { return true; } })());
$('side-toggle')?.addEventListener('click', () => setSide(document.body.dataset.side !== 'on'));

// ---------- Hiển thị kết quả chi tiết ----------
function render(a) {
  $('r-symbol').textContent = a.symbol;
  $('r-exchange').textContent = a.info.exchange || '';
  $('r-name').textContent = a.info.name || '';
  $('r-price').textContent = fmt(a.price.close);

  const changeBadge = $('r-change-badge');
  changeBadge.className = `change-badge ${dirClass(a.price.change)}`;
  $('r-change').textContent = `${signed(a.price.change)} (${signed(a.price.changePct)}%)`;

  // Độ mới dữ liệu: giá trong phiên hay đã đóng cửa, BCTC quý nào
  const er = a.company?.earnings;
  $('r-date').textContent = [
    `Phiên ${a.price.date.split('-').reverse().join('/')}`, a.price.partial ? 'đang giao dịch, giá tạm tính' : 'đã đóng cửa',
    er?.latest && `BCTC ${er.latest}`,
  ].filter(Boolean).join(' · ');

  const rec = $('r-rec');
  rec.className = `recommendation-badge ${a.recommendation.code}`;
  const icon = { BUY: '▲', ACCUMULATE: '↗', HOLD: '●', AVOID: '↘', SELL: '▼' }[a.recommendation.code] || '●';
  rec.textContent = `${icon} ${a.recommendation.label}`;

  // Điểm chính là điểm xếp hạng 4 yếu tố; chỉ số (VN-Index…) không có xếp hạng thì dùng điểm cũ
  $('r-total').textContent = a.ranking ? `${a.ranking.score}/100` : `${signed(a.total, 0)}/100`;
  $('r-conf').textContent = a.ranking ? `${a.ranking.position}/${a.ranking.universe}` : `${a.recommendation.confidence}%`;
  $('r-desc').textContent = a.recommendation.desc;

  // Thống kê đã đo của nhóm điểm này (4 năm, rổ theo thời điểm), thay cho xác suất mô phỏng
  const ex = a.expectation?.h20;
  $('r-exp-win').textContent = ex ? `${Math.round(ex.pBeat * 100)}%` : '–';
  const elEx = $('r-exp-ex');
  elEx.textContent = ex ? `${signed(ex.meanExcess * 100, 1)}%` : '–';
  elEx.className = ex ? dirClass(ex.meanExcess) : '';
  elEx.title = ex ? `80% số lần nằm trong ${signed(ex.p10 * 100, 1)}% đến ${signed(ex.p90 * 100, 1)}%${ex.significant ? '' : ' · chưa có ý nghĩa thống kê'}` : '';

  // Cảnh báo rủi ro
  const W = a.warnings || [];
  $('r-warnings').innerHTML = W.length ? `<section class="card warn-card">
      <div class="warn-head"><b>⚠️ ${W.length} cảnh báo cho ${esc(a.symbol)}</b>
        ${W.length > 3 ? `<button type="button" class="btn btn-ghost btn-xs" data-warn-toggle>Xem cả ${W.length}</button>` : ''}</div>
      <ul class="warn-list">${W.map((w, i) => `<li${i >= 3 ? ' class="more"' : ''}>${esc(w.replace(/^\[([^\]]+)\]\s*/, ''))}${/^\[/.test(w) ? ` <span class="warn-tag">${esc(w.match(/^\[([^\]]+)\]/)[1])}</span>` : ''}</li>`).join('')}</ul>
    </section>` : '';

  // 1. Thẻ Quyết định Mua / Bán (điểm hệ thống; Gemini ghép vào khi có kết quả)
  state.aiError = null;
  renderDecisionCard(a);
  applyAiToDecision(a, null);
  renderMarketGate(a);
  loadHoldBox(a);

  // 2. Điểm số & Biểu đồ nến
  renderChart(a);

  // 3. Khối ngoại mua/bán 20 phiên
  renderForeignChart(a);

  // 5. Tín hiệu kỹ thuật & Kế hoạch tham khảo
  renderPlan(a);
  renderIndicators(a);

  // 6. Cơ bản BCTC & Tin tức
  renderFundamentals(a);
  renderBusiness(a);
  renderNews(a);
  loadAi(a);
  renderRankCard(a);
  renderBrief(a);
  renderFlow(a);
  loadCommittee(a);
  updateAlertPresets(a.price.close);

  // Form cảnh báo giá
  $('alert-form-card').hidden = a.isIndex;
  $('af-symbol').textContent = a.symbol;
  const w = state.watchlist.find((x) => x.symbol === a.symbol);
  const form = $('alert-form');
  form.priceAbove.value = w?.priceAbove ?? '';
  form.priceBelow.value = w?.priceBelow ?? '';
  form.note.value = w?.note ?? '';
  setFold('sec-alerts', w?.priceAbove || w?.priceBelow ? [w.priceAbove && `báo khi ≥ ${fmt(w.priceAbove)}`, w.priceBelow && `báo khi ≤ ${fmt(w.priceBelow)}`].filter(Boolean).join(' · ') : 'Chưa đặt');
  syncFolds();
  updateWatchButton();
}

function updateWatchButton() {
  const a = state.current;
  if (!a) return;
  const btn = $('watch-btn');
  btn.hidden = a.isIndex;
  const watching = state.watchlist.some((w) => w.symbol === a.symbol);
  btn.className = watching ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  btn.innerHTML = watching ? '✓ Đang theo dõi' : '+ Theo dõi mã này';
  btn.onclick = async () => {
    if (watching) {
      await api(`/api/watchlist/${a.symbol}`, { method: 'DELETE' });
      showToast(`Đã bỏ theo dõi ${a.symbol}`, 'info');
    } else {
      await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: a.symbol }) });
      showToast(`Đã thêm ${a.symbol} vào danh mục theo dõi`, 'success');
    }
    await loadWatchlist();
    updateWatchButton();
  };
}

function updateAlertPresets(close) {
  if (!close) return;
  const chips = document.querySelectorAll('#alert-presets-chips .preset-chip');
  chips.forEach((c) => {
    const pct = Number(c.dataset.pct);
    const target = Math.round((close * (1 + pct / 100)) * 100) / 100;
    c.textContent = `${pct > 0 ? '+' : ''}${pct}% (${target})`;
  });
}

$('copy-json-hero')?.addEventListener('click', () => {
  if (!state.current) return;
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã copy toàn bộ JSON phân tích vào clipboard!', 'success');
});

// JSON Inspector Modal
function openJsonModal() {
  if (!state.current) {
    showToast('Hãy chọn 1 mã để phân tích trước!', 'info');
    return;
  }
  $('json-modal-sym').textContent = `${state.current.symbol} · ${new Date().toLocaleTimeString('vi-VN')}`;
  $('json-modal-content').textContent = JSON.stringify(state.current, null, 2);
  $('json-modal').hidden = false;
}

$('btn-open-json-modal')?.addEventListener('click', openJsonModal);
$('btn-view-raw-json')?.addEventListener('click', () => {
  $('tools-dropdown')?.classList.remove('open');
  openJsonModal();
});
$('btn-close-json-modal')?.addEventListener('click', () => {
  $('json-modal').hidden = true;
});
$('json-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'json-modal') $('json-modal').hidden = true;
});
$('btn-copy-modal-json')?.addEventListener('click', () => {
  if (!state.current) return;
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã sao chép JSON!', 'success');
});

$('test-alert-hero')?.addEventListener('click', async () => {
  if (!state.current) return;
  try {
    await api('/api/alerts/test', {
      method: 'POST',
      body: JSON.stringify({ symbol: state.current.symbol, message: `Giá ${state.current.symbol} vừa chạm ngưỡng thử nghiệm cảnh báo.` }),
    });
    await loadAlerts();
    showToast(`Đã kích hoạt cảnh báo test cho ${state.current.symbol}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- THẺ QUYẾT ĐỊNH MUA / BÁN (DECISION CARD) ----------
function renderDecisionCard(a) {
  const card = $('decision-card');
  if (!card) return;

  // Kết luận, hành động và mức giá đã nằm ở thẻ Tóm tắt phía trên; thẻ này chỉ còn căn cứ chi tiết
  card.className = 'card decision-card';

  // Dòng tiền & Khối ngoại mua/bán
  const mf = a.marketFlow;
  const f = a.foreign;
  let flowHtml = '';
  if (mf) {
    flowHtml += `
      <div class="dc-flow-row"><span class="k">Độ rộng toàn sàn (${mf.floor})</span><span class="v"><b class="up">${mf.advancers} tăng</b> / <b class="down">${mf.decliners} giảm</b></span></div>
      <div class="dc-flow-row"><span class="k">Khối ngoại toàn sàn</span><span class="v ${dirClass(mf.foreign?.netVal)}">${signed((mf.foreign?.netVal || 0) / 1e9, 0)} tỷ</span></div>
    `;
  }
  if (f) {
    flowHtml += `
      <div class="dc-flow-row"><span class="k">Khối ngoại mã này (phiên)</span><span class="v ${dirClass(f.net1)}">${signed((f.net1 || 0) / 1e9, 1)} tỷ</span></div>
      <div class="dc-flow-row"><span class="k">Khối ngoại 5 phiên gần nhất</span><span class="v ${dirClass(f.net5)}">${signed((f.net5 || 0) / 1e9, 1)} tỷ (${f.buyDays5}/5 mua)</span></div>
    `;
  }
  $('dc-flow').innerHTML = flowHtml || '<span class="muted small">Chưa có số liệu dòng tiền</span>';

  // Điều kiện mua: luật độ rộng thị trường (đã kiểm định, dùng cho tool tự đầu tư)
  const br = a.marketRegime?.breadth?.pctAboveMa50;
  $('dc-watch').innerHTML = br == null
    ? '<b>Độ rộng thị trường:</b> chưa có số liệu.'
    : `<b>Độ rộng thị trường:</b> ${Math.round(br)}% mã trên MA50 → ${br < 50 ? '<span class="down">dưới 50%: không mua mới, mã đang giữ vẫn theo luật giữ / bán</span>' : '<span class="up">từ 50% trở lên: được mua mới theo xếp hạng</span>'}`;

  // Điểm mạnh / rủi ro: chỉ những yếu tố đã kiểm định trên dữ liệu 4–8 năm
  const r = a.ranking;
  const pros = [], cons = [];
  if (r) {
    for (const [k, label] of RANK_PART_LABEL) {
      const v = r.parts?.[k];
      if (v == null) continue;
      if (v >= 70) pros.push(`${label}: phân vị ${Math.round(v)}/100`);
      else if (v <= 30) cons.push(`${label}: phân vị ${Math.round(v)}/100`);
    }
    if (r.trendPick) pros.push('Xu hướng chuẩn: gần đỉnh 52 tuần và biến động êm');
    if (r.aboveMa200 === true) pros.push('Giá trên MA200 (xu hướng dài hạn tốt)');
    if (r.aboveMa200 === false) cons.push('Giá dưới MA200: nhóm này kém rổ trong kiểm định');
    if (r.avoid) cons.unshift('⛔ Thuộc 10% điểm thấp nhất rổ: kém rổ ≈ 1,3% mỗi 20 phiên');
  }
  if (a.stockRisk?.isRisky) cons.push(`Rủi ro rơi tự do: ${a.stockRisk.reasons.join(', ')}`);
  for (const w of a.buyWarnings || []) cons.push(`${w.name}: ${w.text}`);
  if (br != null && br < 50) cons.push(`Thị trường yếu: chỉ ${Math.round(br)}% mã trên MA50`);

  $('dc-pros').innerHTML = pros.length ? pros.map((p) => `<li>${esc(p)}</li>`).join('') : '<li class="muted">Chưa có yếu tố mạnh nổi trội.</li>';
  $('dc-cons').innerHTML = cons.length ? cons.map((c) => `<li>${esc(c)}</li>`).join('') : '<li class="muted">Chưa ghi nhận rủi ro đã kiểm định.</li>';
  setFold('sec-decision', `${pros.length} điểm mạnh · ${cons.length} rủi ro`, cons.length > pros.length ? 'down' : pros.length > cons.length ? 'up' : '');
}

const RANK_PART_LABEL = [['mom', 'Động lượng 12 tháng'], ['high', 'Gần đỉnh 52 tuần'], ['atr', 'Biến động thấp'], ['adx', 'Xu hướng rõ (ADX)']];

// Banner đầu trang: luật độ rộng thị trường áp cho mọi lệnh mua mới
function renderMarketGate(a) {
  const el = $('r-market-gate');
  const br = a.marketRegime?.breadth?.pctAboveMa50;
  if (a.isIndex || br == null) { el.innerHTML = ''; return; }
  el.innerHTML = br < 50
    ? `<div class="warning"><span>⏸ Thị trường yếu: chỉ <b>${Math.round(br)}%</b> mã trên MA50 (dưới 50%). Luật đã kiểm định: <b>không mua mới</b>, kể cả mã điểm cao.</span></div>`
    : '';
}

// Nếu đang nắm mã này: BÁN / XEM LẠI / GIỮ / MUA THÊM và rủi ro, cùng cách tính với trang Danh mục và Telegram
async function loadHoldBox(a) {
  const el = $('qc-hold');
  el.hidden = true;
  if (a.isIndex || !a.holding) return;
  try {
    const d = await api('/api/portfolio/advice');
    const x = d.items.find((i) => i.symbol === a.symbol);
    if (!x || state.current?.symbol !== a.symbol) return;
    el.innerHTML = `<span class="st-badge ${ADVICE_TONE[x.action] || ''}">${esc(x.action)}</span>
      <span><b>Bạn đang nắm ${fmt(x.qty, 0)} cp</b>, ${x.pnlPct >= 0 ? 'lãi' : 'lỗ'} <b class="${dirClass(x.pnlPct)}">${signed(x.pnlPct * 100)}%</b>${x.held != null ? ` · đã giữ ${x.held}/${x.N} phiên` : ''}. ${esc(short(x.why.split(';')[0], 80))}</span>`;
    el.hidden = false;
  } catch { /* không có thì thôi */ }
}

// ---------- KHỐI NGOẠI MUA / BÁN 20 PHIÊN (SVG CHART) ----------
function renderForeignChart(a) {
  const container = $('foreign-chart');
  const statsEl = $('foreign-stats');
  const summaryEl = $('foreign-summary');
  if (!container || !a.foreign?.history) {
    $('foreign-card').hidden = true;
    return;
  }
  $('foreign-card').hidden = false;
  const f = a.foreign;
  const hist = [...f.history].reverse(); // Từ ngày cũ đến mới nhất
  const maxNet = Math.max(...hist.map((h) => Math.abs(h.netVal || 0)), 1e8);

  const w = 700;
  const h = 160;
  const padBottom = 24;
  const padTop = 10;
  const barW = Math.max(4, Math.floor(w / hist.length) - 6);
  const midY = (h - padBottom - padTop) / 2 + padTop;
  const scale = ((h - padBottom - padTop) / 2) / maxNet;

  const svgBars = hist.map((d, i) => {
    const x = i * (w / hist.length) + 4;
    const val = d.netVal || 0;
    const barH = Math.max(3, Math.abs(val) * scale);
    const y = val >= 0 ? midY - barH : midY;
    const cls = val >= 0 ? 'pos' : 'neg';
    const dateStr = d.date ? d.date.slice(5) : '';
    const valBillion = (val / 1e9).toFixed(1);
    return `
      <rect class="bar ${cls}" x="${x}" y="${y}" width="${barW}" height="${barH}" rx="2">
        <title>${d.date}: ${val >= 0 ? '+' : ''}${valBillion} tỷ (Mua: ${(d.buyVal / 1e9).toFixed(1)} tỷ, Bán: ${(d.sellVal / 1e9).toFixed(1)} tỷ)</title>
      </rect>
      ${i % 3 === 0 ? `<text x="${x + barW / 2}" y="${h - 6}" text-anchor="middle">${dateStr}</text>` : ''}
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      <line class="zero" x1="0" y1="${midY}" x2="${w}" y2="${midY}"></line>
      ${svgBars}
    </svg>
  `;

  summaryEl.textContent = `${f.buyDays5 ?? '–'}/5 phiên mua ròng gần nhất`;
  setFold('sec-foreign', `${(f.net5 || 0) >= 0 ? 'Mua' : 'Bán'} ròng ${fmt(Math.abs(f.net5 || 0) / 1e9, 0)} tỷ / 5 phiên`, dirClass(f.net5));
  statsEl.innerHTML = `
    <span>Phiên gần nhất: <b class="${dirClass(f.net1)}">${signed((f.net1 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Mua ròng 5 phiên: <b class="${dirClass(f.net5)}">${signed((f.net5 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Mua ròng 20 phiên: <b class="${dirClass(f.net20)}">${signed((f.net20 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Tỷ lệ so với GTGD: <b>${f.ratio20 != null ? `${signed(f.ratio20, 1)}%` : '–'}</b></span>
  `;
}

// Cho phép vuốt dọc trên điện thoại để cuộn trang thay vì bị biểu đồ giữ lại
const CHART_TOUCH = { handleScroll: { vertTouchDrag: false } };
// ---------- Biểu đồ giá LightweightCharts ----------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Khung nến và các phạm vi hiển thị tương ứng (số nến)
const CHART_TF = {
  D: { unit: 'phiên', ranges: [['3 Tháng', 66], ['6 Tháng', 132], ['1 Năm', 250], ['Tất cả', 0]], def: 132 },
  W: { unit: 'tuần', ranges: [['1 Năm', 52], ['2 Năm', 104], ['5 Năm', 260], ['Tất cả', 0]], def: 104 },
  M: { unit: 'tháng', ranges: [['2 Năm', 24], ['5 Năm', 60], ['10 Năm', 120], ['Tất cả', 0]], def: 60 },
};
state.chartTf = 'D';
state.chartCache = new Map(); // mã:khung -> dữ liệu nến tuần/tháng
let chartReq = 0;

function renderRangeButtons() {
  const cfg = CHART_TF[state.chartTf];
  $('range').innerHTML = cfg.ranges.map(([label, n]) => `<button type="button" data-days="${n}"${n === state.chartDays ? ' class="on"' : ''}>${label}</button>`).join('');
  document.querySelectorAll('#chart-tf button').forEach((b) => b.classList.toggle('on', b.dataset.tf === state.chartTf));
}

// Các lớp có thể bật/tắt trên biểu đồ giá (nhớ theo trình duyệt)
const CHART_LAYERS = [
  { key: 'ma20', label: 'MA20', color: '--s1' },
  { key: 'ma50', label: 'MA50', color: '--s2' },
  { key: 'ma200', label: 'MA200', color: '--s3' },
  { key: 'cone', label: 'Dải 20 phiên tới', color: '--accent', daily: true },
  { key: 'stop', label: 'Ngưỡng thoát', color: '--down' },
  { key: 'vol', label: 'Khối lượng', color: '--muted' },
];
state.chartLayers = (() => {
  const def = { ma20: true, ma50: true, ma200: true, cone: true, stop: true, vol: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem('vnstock_chart_layers') || '{}') }; } catch { return def; }
})();

/** Vẽ biểu đồ theo khung đang chọn: nến ngày lấy từ kết quả phân tích, nến tuần/tháng tải riêng (lịch sử dài hơn). */
// Dải thống kê dùng chung giữa biểu đồ giá và thẻ Dự báo (một lần gọi cho mỗi mã, số phiên và lần phân tích)
const fcCache = new Map();
function getForecastData(a, h) {
  const key = `${a.symbol}:${h}:${a.updatedAt}`;
  if (!fcCache.has(key)) {
    const p = api(`/api/forecast/${a.symbol}?h=${h}`);
    p.catch(() => fcCache.delete(key));
    fcCache.set(key, p);
  }
  return fcCache.get(key);
}

async function renderChart(a) {
  renderRangeButtons();
  const tf = state.chartTf;
  if (tf === 'D') {
    const key = `${a.symbol}:${a.updatedAt}`;
    drawChart(a, a.chart, tf, state.coneFor === key ? state.cone : null);
    if (a.isIndex || state.coneFor === key || !state.chartLayers.cone) return;
    const req = ++chartReq;
    const d = await getForecastData(a, 20).catch(() => null);
    if (!d || req !== chartReq || state.current !== a || state.chartTf !== 'D') return;
    state.cone = d.cone; state.coneFor = key;
    drawChart(a, a.chart, tf, d.cone);
    return;
  }
  const key = `${a.symbol}:${tf}`;
  const req = ++chartReq;
  if (!state.chartCache.has(key)) {
    $('chart').innerHTML = '<div class="loading-state" style="border:none;padding:40px"><span>Đang tải nến ' + (tf === 'W' ? 'tuần' : 'tháng') + '…</span></div>';
    try {
      state.chartCache.set(key, await api(`/api/chart/${a.symbol}?tf=${tf}`));
    } catch (err) {
      if (req === chartReq) $('chart').innerHTML = `<p class="error" style="padding:20px">${esc(err.message)}</p>`;
      return;
    }
  }
  if (req !== chartReq || state.current?.symbol !== a.symbol || state.chartTf !== tf) return;
  drawChart(a, state.chartCache.get(key), tf);
}

const dmy = (t) => (t ? `${t.slice(8, 10)}/${t.slice(5, 7)}/${t.slice(0, 4)}` : '');

function drawChart(a, data, tf, coneData = null) {
  const el = $('chart');
  if (state.chart) {
    state.chart.remove();
    state.chart = null;
  }
  if (!window.LightweightCharts) {
    el.innerHTML = '<p class="muted" style="padding:20px">Không tải được thư viện biểu đồ LightweightCharts.</p>';
    return;
  }
  el.innerHTML = '';
  const LC = window.LightweightCharts;
  const L = state.chartLayers;
  const chart = LC.createChart(el, {
    autoSize: true,
    ...CHART_TOUCH,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: L.vol ? 0.22 : 0.06 } },
    timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: { color: css('--muted'), labelBackgroundColor: css('--surface-2') },
      horzLine: { color: css('--muted'), labelBackgroundColor: css('--surface-2') },
    },
    watermark: { visible: true, text: `${a.symbol} · ${tf === 'W' ? 'Tuần' : tf === 'M' ? 'Tháng' : 'Ngày'}`, fontSize: 40, color: withAlpha(css('--muted'), 0.08) },
    localization: { locale: 'vi-VN', priceFormatter: (v) => fmt(v) },
  });

  const up = css('--up') || '#10b981';
  const down = css('--down') || '#f43f5e';
  const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceLineColor: css('--muted'), priceLineStyle: LC.LineStyle.Dotted });
  candles.setData(data.bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  const lineOpts = (color, extra = {}) => ({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
  const ma = [['ma20', data.sma20], ['ma50', data.sma50], ['ma200', data.sma200]].map(([key, pts]) => {
    const lay = CHART_LAYERS.find((x) => x.key === key);
    if (L[key]) chart.addLineSeries(lineOpts(css(lay.color))).setData(pts);
    return { key, at: new Map(pts.map((p) => [p.time, p.value])) };
  });

  if (L.vol) {
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(data.bars.map((b, i, arr) => ({ time: b.time, value: b.volume, color: withAlpha(i && b.close < arr[i - 1].close ? down : up, 0.35) })));
  }

  // Ngưỡng thoát của luật nắm giữ (−15% giá vốn, hoặc −15% giá hiện tại nếu chưa có cổ phiếu)
  const warn = a.brief?.levels?.holdStop ?? a.plan?.hold?.warnStop;
  if (L.stop && warn) candles.createPriceLine({ price: warn, color: down, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'Ngưỡng thoát' });

  // Dải dao động 20 phiên tới (cùng dải thống kê với thẻ Dự báo): trung vị và khoảng 90% (5–95%)
  const proj = tf === 'D' && L.cone && data.bars.length && coneData ? coneData.map((c) => ({ time: c.date, p10: c.p05, p50: c.p50, p90: c.p95 })) : [];
  const cone = new Map(proj.map((s) => [s.time, s]));
  const lastClose = data.bars.at(-1)?.close;
  if (proj.length) {
    const start = { time: data.bars.at(-1).time, value: lastClose };
    const acc = css('--accent');
    const edge = lineOpts(withAlpha(acc, 0.6), { lineWidth: 1, lineStyle: LC.LineStyle.Dotted });
    chart.addLineSeries(edge).setData([start, ...proj.map((s) => ({ time: s.time, value: s.p90 }))]);
    chart.addLineSeries(edge).setData([start, ...proj.map((s) => ({ time: s.time, value: s.p10 }))]);
    chart.addLineSeries(lineOpts(acc, { lineWidth: 2, lineStyle: LC.LineStyle.Dashed, lastValueVisible: true, title: 'Trung vị' }))
      .setData([start, ...proj.map((s) => ({ time: s.time, value: s.p50 }))]);
  }

  // Thanh giá: ngày, OHLC, % và khối lượng của nến đang trỏ; ngày tương lai thì hiện dải dự báo
  const legend = $('chart-legend');
  const idxByTime = new Map(data.bars.map((b, i) => [b.time, i]));
  const q = (k, v, cls = '') => `<div class="q-item"><span>${k}</span><b class="num ${cls}">${v}</b></div>`;
  const updateLayerValues = (t) => {
    for (const m of ma) {
      const node = document.querySelector(`#chart-layers [data-layer="${m.key}"] .lc-val`);
      const v = t ? m.at.get(t) : null;
      if (node) node.textContent = v != null ? fmt(v) : '';
    }
  };
  const showLegend = (time) => {
    const f = time && cone.get(time);
    if (f) {
      const cls = dirClass(f.p50 - lastClose);
      legend.innerHTML = `<div class="q-date">${dmy(time)} <span class="q-tag">dự báo</span></div>
        ${q('Trung vị', fmt(f.p50), cls)}${q('90% trong khoảng', `${fmt(f.p10)} – ${fmt(f.p90)}`)}
        ${q('So với hiện tại', `${signed((f.p50 / lastClose - 1) * 100, 1)}%`, cls)}`;
      updateLayerValues(null);
      return;
    }
    const i = idxByTime.get(time) ?? data.bars.length - 1;
    const b = data.bars[i];
    if (!b) return;
    const prev = data.bars[i - 1];
    const ch = prev ? ((b.close - prev.close) / prev.close) * 100 : 0;
    const label = tf === 'W' ? `Tuần từ ${dmy(b.time)}` : tf === 'M' ? `Tháng ${b.time.slice(5, 7)}/${b.time.slice(0, 4)}` : dmy(b.time);
    legend.innerHTML = `<div class="q-date">${label}</div>
      ${q('Mở', fmt(b.open))}${q('Cao', fmt(b.high))}${q('Thấp', fmt(b.low))}
      <div class="q-item q-close"><span>Đóng</span><b class="num">${fmt(b.close)}</b><em class="num ${dirClass(ch)}">${signed(ch)}%</em></div>
      ${q('Khối lượng', fmt(b.volume, 0))}`;
    updateLayerValues(b.time);
  };
  renderLayerChips(tf, Boolean(warn));
  chart.subscribeCrosshairMove((p) => showLegend(p.time));
  showLegend(null);

  $('chart-foot').textContent = proj.length
    ? 'Vùng bên phải: giá có thể dao động trong 20 phiên tới (ước lượng biên độ, không dự báo hướng).'
    : `Mỗi nến là một ${CHART_TF[tf].unit}.`;

  state.chart = chart;
  state.chartBars = data.bars.length;
  state.chartAhead = proj.length;
  setRange(state.chartDays);
}

function renderLayerChips(tf, hasStop) {
  $('chart-layers').innerHTML = CHART_LAYERS
    .filter((l) => (!l.daily || tf === 'D') && (l.key !== 'stop' || hasStop))
    .map((l) => `<button type="button" class="layer-chip${state.chartLayers[l.key] ? ' on' : ''}" data-layer="${l.key}" aria-pressed="${!!state.chartLayers[l.key]}">
      <i class="lc-sw lc-${l.key}" style="--c:var(${l.color})"></i>${l.label}<span class="lc-val num"></span></button>`).join('');
}

function setRange(days) {
  state.chartDays = days;
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
  if (!state.chart || !state.current) return;
  const n = state.chartBars || 0;
  const ahead = (state.chartAhead || 0) + 3; // chừa chỗ cho dải dự báo phía bên phải
  state.chart.timeScale().setVisibleLogicalRange({ from: !days || days >= n ? 0 : n - days, to: n + ahead });
}

$('chart-layers')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-layer]');
  if (!b || !state.current) return;
  const k = b.dataset.layer;
  state.chartLayers[k] = !state.chartLayers[k];
  try { localStorage.setItem('vnstock_chart_layers', JSON.stringify(state.chartLayers)); } catch { /* bỏ qua */ }
  renderChart(state.current);
});

$('chart-tf')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tf]');
  if (!b || b.dataset.tf === state.chartTf) return;
  state.chartTf = b.dataset.tf;
  state.chartDays = CHART_TF[state.chartTf].def;
  if (state.current) renderChart(state.current);
  else renderRangeButtons();
});

$('range')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setRange(Number(b.dataset.days));
});

// ---------- Mức giá & chỉ báo ----------
function kv(rows) {
  return rows.map(([k, v, cls = '']) => `<span class="k">${k}</span><span class="v ${cls}">${v}</span>`).join('');
}

function renderPlan(a) {
  $('plan-card').hidden = !a.plan;
  if (!a.plan) return;
  const p = a.plan, c = a.price.close;
  const pct = (x) => `${signed(((x - c) / c) * 100, 1)}%`;
  $('r-plan').innerHTML = kv([
    ['Giá hiện tại', fmt(c)],
    ['Hỗ trợ (đáy 20 phiên)', `${fmt(p.support)} <span class="muted small">${pct(p.support)}</span>`],
    ['Kháng cự (đỉnh 20 phiên)', `${fmt(p.resistance)} <span class="muted small">${pct(p.resistance)}</span>`],
    // Đang giữ: −15% giá vốn (giống thẻ tóm tắt); chưa có: −15% nếu mua ở giá hiện tại
    (() => {
      const held = a.brief?.levels?.holdStop;
      const w = held ?? p.hold?.warnStop;
      return [held ? 'Ngưỡng thoát (−15% giá vốn)' : 'Ngưỡng thoát nếu mua giá này', w ? `${fmt(w)} <span class="small">${pct(w)}</span>` : '–', 'down'];
    })(),
    ['Thời gian giữ', p.hold ? `${p.hold.reviewAfter} phiên rồi xem lại` : '–'],
    ['Giá − 2×ATR (mức rung lắc)', `${fmt(p.stopLoss)} <span class="muted small">${pct(p.stopLoss)}</span>`],
    ['Giá + 3×ATR', `${fmt(p.target)} <span class="muted small">${pct(p.target)}</span>`],
    ['Biên độ ATR(14)', fmt(p.atr)],
  ]);
}

function renderIndicators(a) {
  const i = a.technical.indicators;
  const rsiCls = i.rsi14 > 70 ? 'down' : i.rsi14 < 30 ? 'up' : '';
  $('r-ind').innerHTML = kv([
    ['RSI(14)', fmt(i.rsi14, 1), rsiCls],
    ['MACD / Signal', `${fmt(i.macd, 2)} / ${fmt(i.macdSignal, 2)}`, dirClass(i.macdHist)],
    ['MA20 · MA50 · MA200', `${fmt(i.sma20)} · ${fmt(i.sma50)} · ${fmt(i.sma200)}`],
    ['Dải Bollinger (Dưới – Trên)', `${fmt(i.bbLower)} – ${fmt(i.bbUpper)}`],
    ['Khối lượng phiên / TB20', `${fmt(i.volume, 0)} / ${fmt(i.avgVolume20, 0)}`],
    ['Hiệu suất 5 phiên', `${signed(i.return5d, 1)}%`, dirClass(i.return5d)],
    ['Hiệu suất 20 phiên', `${signed(i.return20d, 1)}%`, dirClass(i.return20d)],
    ['Hiệu suất 60 phiên', `${signed(i.return60d, 1)}%`, dirClass(i.return60d)],
    ['Hiệu suất 1 năm', `${signed(i.return250d, 1)}%`, dirClass(i.return250d)],
  ]);
}

function renderFundamentals(a) {
  const f = a.fundamental.data;
  $('fund-card').hidden = !f;
  if (!f) return;
  $('r-fund-date').textContent = f.reportDate ? `BCTC kỳ ${f.reportDate}` : '';
  setFold('sec-fund', `P/E ${fmt(f.pe, 1)} · ROE ${fmtPct(f.roe)} · LN 4 quý ${fmtPct(f.profitGrowthTTM)}`);
  const items = [
    ['P/E', fmt(f.pe, 1)], ['P/B', fmt(f.pb, 2)], ['P/S', fmt(f.ps, 2)],
    ['EPS 4 quý (VNĐ)', fmt(f.epsTTM, 0)], ['BVPS (VNĐ)', fmt(f.bookValuePerShare, 0)],
    ['ROE', fmtPct(f.roe)], ['ROA', fmtPct(f.roa)],
    ['Tăng trưởng LN 4Q', fmtPct(f.profitGrowthTTM), dirClass(f.profitGrowthTTM)],
    ['Tăng trưởng DT 4Q', fmtPct(f.revenueGrowthTTM), dirClass(f.revenueGrowthTTM)],
    ['LN quý vs cùng kỳ', fmtPct(f.profitGrowthQoQYoY), dirClass(f.profitGrowthQoQYoY)],
    ['Biên LN gộp', fmtPct(f.grossMarginTTM)], ['Biên LN ròng', fmtPct(f.netMarginTTM)],
    ['Nợ vay / VCSH', fmt(f.debtToEquity, 2)], ['Thanh toán hiện hành', fmt(f.currentRatio, 2)],
    ['Tỷ suất cổ tức', fmtPct(f.dividendYield)], ['Hệ số Beta', fmt(f.beta, 2)],
    ['Vốn hóa thị trường', fmtBig(f.marketCap)], ['Doanh thu 4Q', fmtBig(f.revenueTTM)], ['LN ròng 4Q', fmtBig(f.netProfitTTM)],
    ['Đỉnh / Đáy 52 tuần', `${fmt(f.high52w / 1000)} / ${fmt(f.low52w / 1000)}`],
    ['Sở hữu nước ngoài', fmtPct(f.foreignOwnership)],
  ];
  $('r-fund').innerHTML = items.map(([k, v, cls = '']) => `
    <div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>
  `).join('');
}

const LABELS = { tich_cuc: 'Tích cực', tieu_cuc: 'Tiêu cực', trung_lap: 'Trung lập' };

function renderNews(a) {
  const items = a.news.items.filter((n) => state.newsFilter === 'all' || n.label === state.newsFilter);
  const f = a.news.aiFilter;
  setFold('sec-news', `${a.news.positive} tích cực · ${a.news.negative} tiêu cực`, a.news.negative > a.news.positive ? 'down' : a.news.positive > a.news.negative ? 'up' : '');
  $('r-news-count').textContent = `(${a.news.count} tin · ${a.news.positive} tích cực · ${a.news.negative} tiêu cực${f?.checked ? ` · AI đã lọc${f.removed.length ? `, bỏ ${f.removed.length} tin không liên quan` : ''}` : ''})`;
  $('r-news').innerHTML = items.length ? items.map((n) => `
    <li>
      <span class="chip ${n.label}" title="${n.ai ? 'Nhãn do AI đọc tin' : 'Nhãn theo từ khóa (AI chưa đọc)'}">${LABELS[n.label]}${n.ai ? ' · AI' : ''}</span>
      <div>
        <a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.title)} ↗</a>
        <div class="meta">${esc(n.source)} · ${timeAgo(n.publishedAt)}</div>
        ${n.ai?.reason ? `<div class="kw">AI: ${esc(n.ai.reason)}${n.ai.risk ? ' · ⚠ rủi ro nghiêm trọng' : ''}</div>`
          : n.keywords.length ? `<div class="kw">Từ khóa: ${n.keywords.map(esc).join(', ')}</div>` : ''}
      </div>
    </li>
  `).join('') : '<li class="muted" style="padding:10px">Không có tin tức phù hợp trong bộ lọc này.</li>';
}

$('news-filter')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.newsFilter = b.dataset.f;
  document.querySelectorAll('#news-filter button').forEach((x) => x.classList.toggle('on', x === b));
  if (state.current) renderNews(state.current);
});

// ---------- Cài đặt Cảnh báo Giá & Preset Chips ----------
$('alert-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('af-submit');
  btn.disabled = true;
  try {
    await api('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({
        symbol: state.current.symbol,
        priceAbove: f.priceAbove.value,
        priceBelow: f.priceBelow.value,
        note: f.note.value,
      }),
    });
    await loadWatchlist();
    updateWatchButton();
    showToast(`Đã lưu cảnh báo giá cho ${state.current.symbol}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('alert-presets-chips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-pct]');
  if (!chip || !state.current?.price?.close) return;
  const pct = Number(chip.dataset.pct);
  const cur = state.current.price.close;
  const target = Math.round((cur * (1 + pct / 100)) * 100) / 100;
  if (pct > 0) {
    $('af-price-above').value = target;
    showToast(`Đã thiết lập ngưỡng giá trên ≥ ${target} (+${pct}%)`, 'info');
  } else {
    $('af-price-below').value = target;
    showToast(`Đã thiết lập ngưỡng giá dưới ≤ ${target} (${pct}%)`, 'info');
  }
});

// ---------- Phân tích AI (Gemini) ----------
async function loadAi(a) {
  $('ai-card').hidden = a.isIndex;
  if (a.isIndex) return;
  const btn = $('ai-btn');
  $('ai-model').textContent = state.ai.enabled ? `· Gemini` : '';
  if (!state.ai.enabled) {
    btn.hidden = true;
    $('ai-body').innerHTML = `
      <p class="muted" style="padding:14px">Chưa bật Gemini. Tạo API key miễn phí tại
      <b>aistudio.google.com/apikey</b>, sao chép <code>.env.example</code> thành <code>.env</code>,
      điền <code>GEMINI_API_KEY</code> rồi khởi động lại server.</p>
    `;
    return;
  }
  btn.hidden = false;
  $('ai-body').innerHTML = '';
  const saved = await api(`/api/ai/${a.symbol}`).catch(() => null);
  if (state.current?.symbol !== a.symbol) return;
  if (saved) {
    renderAi(saved);
    applyAiToDecision(a, saved);
  } else {
    $('ai-body').innerHTML = `
      <p class="muted" style="padding:14px">Gemini sẽ đọc toàn bộ dữ liệu giá, BCTC và tin tức để đưa ra nhận định chuyên sâu.</p>
    `;
  }
  // Quy trình Gemini + hội đồng được tự chạy ở loadCommittee
}

/**
 * Chạy quy trình quyết định trên server: Gemini → phe mua/phe bán → giám đốc đầu tư.
 * Tiến độ và kết quả được renderCommittee theo dõi. force = Gemini phân tích lại (bỏ cache 30 phút).
 */
async function runAiFor(a, force = true) {
  state.aiRunning = a.symbol;
  state.aiError = null;
  state.cmStage = 'Chuẩn bị';
  $('ai-btn').disabled = true;
  if (state.current?.symbol === a.symbol) applyAiToDecision(a, state.aiResult);
  try {
    const s = await api(`/api/committee/${a.symbol}`, { method: 'POST', body: JSON.stringify({ force }) });
    if (state.current?.symbol === a.symbol) renderCommittee(s, a);
  } catch (err) {
    state.aiRunning = null;
    state.aiError = { symbol: a.symbol, message: err.message };
    $('ai-btn').disabled = false;
    if (state.current?.symbol === a.symbol) applyAiToDecision(a, state.aiResult);
  }
}
$('ai-btn')?.addEventListener('click', () => state.current && runAiFor(state.current));

/** Quyết định cuối (đã qua Gemini và hội đồng) của mã đang xem, chỉ khi cùng phiên giá. */
function currentFinal(a) {
  const r = state.cmResult;
  return r?.symbol === a.symbol && r.final && r.final.priceDate === a.price.date ? r.final : null;
}

// ---------- Ghép nhận định Gemini vào thẻ Căn cứ chi tiết ----------

/**
 * Vẽ lại thẻ Tóm tắt (quyết định cuối) và, khi có kết quả Gemini, thay luận điểm mua, rủi ro,
 * điều kiện theo dõi và nhận định dòng tiền ở thẻ Căn cứ chi tiết.
 */
function applyAiToDecision(a, ai) {
  state.aiResult = ai && ai.symbol === a.symbol ? ai : null;
  ai = state.aiResult;
  if (state.current?.symbol === a.symbol) { renderBrief(a); renderFlow(a); renderBusiness(a); }
  // Kết luận, trạng thái AI, hành động và mức giá hiển thị ở thẻ Tóm tắt; ở đây chỉ thay căn cứ chi tiết
  if (!ai) return;

  // Điểm mạnh / rủi ro giữ bản đã kiểm định; luận điểm của AI xem ở thẻ AI
  if (ai.marketFlowView) {
    const flow = $('dc-flow');
    flow.querySelector('.dc-note')?.remove();
    flow.insertAdjacentHTML('beforeend', `<div class="dc-note">${esc(ai.marketFlowView)}</div>`);
  }
}

// ---------- CỔ PHIẾU TIỀM NĂNG ----------
const PICK_TONE = { MUA: 'up', MUA_THAM_DO: 'up', CHO_DIEM_MUA: 'ref', LOAI: 'down' };

function showPicks() {
  ['marketview', 'empty', 'error', 'report', 'loading', 'portfolio', 'rankview', 'sectorview', 'autoview'].forEach((id) => ($(id).hidden = true));
  $('auto-btn')?.classList.remove('on');
  markMobileView('picks', 'picks');
  $('sector-btn')?.classList.remove('on');
  $('pf-btn')?.classList.remove('on');
  $('rank-btn')?.classList.remove('on');
  $('picks').hidden = false;
  $('picks-btn')?.classList.add('on');
  history.replaceState(null, '', '#tiem-nang');
  loadPicks();
}

async function loadPicks() {
  clearTimeout(state.picksTimer);
  let s;
  try {
    s = await api('/api/screener');
  } catch (err) {
    $('pk-list').innerHTML = `<div class="card pk-empty">Không tải được: ${esc(err.message)}</div>`;
    return;
  }
  renderPicks(s);
  // Đang quét: hỏi lại mỗi 2 giây để cập nhật tiến độ
  if (s.status === 'running' && !$('picks').hidden) state.picksTimer = setTimeout(loadPicks, 2000);
}

function renderPicks(s) {
  const r = s.result;
  const running = s.status === 'running';
  $('pk-run-btn').disabled = running;
  $('pk-ai-btn').disabled = running || !r?.candidates?.length || !state.ai.enabled;

  $('pk-progress').hidden = !running;
  if (running && s.progress) {
    const p = s.progress;
    $('pk-progress-label').textContent = `Bước ${p.stage}/3: ${p.label}${p.total > 1 ? ` (${p.done}/${p.total})` : '…'}`;
    const pctDone = ((Math.max(0, p.stage - 1) + (p.total ? p.done / p.total : 0)) / 3) * 100;
    $('pk-bar-fill').style.width = `${Math.min(100, pctDone)}%`;
  }

  if (!r) {
    $('pk-summary').hidden = true;
    $('pk-sectors').hidden = true;
    $('pk-sub').textContent = '';
    $('pk-market').innerHTML = '';
    $('pk-rejected').hidden = true;
    $('pk-list').innerHTML = running ? '' : `<div class="card pk-empty">
      ${s.status === 'error' ? `<p class="down">Lần quét trước lỗi: ${esc(s.error)}</p>` : ''}
      <p>Chưa có kết quả. Bấm <b>Quét lại thị trường</b> để tìm cổ phiếu tiềm năng (mất khoảng 1–4 phút).</p></div>`;
    return;
  }

  const ai = r.ai && !r.ai.error ? r.ai : null;
  const fn = r.funnel;
  $('pk-sub').textContent = `Phiên ${r.date.split('-').reverse().join('/')} · quét ${r.scanned} mã`
    + (fn ? ` → ${fn.liquidity} mã thanh khoản đều ≥ 5 tỷ → ${fn.quality} mã cơ bản tốt${fn.sector != null ? ` → ${fn.sector} mã thuộc ngành đang được mua` : ''} → ${fn.trend} mã xu hướng mạnh` : '')
    + ` · phân tích sâu ${r.shortlisted} mã · `
    + `chọn ${r.candidates.length} mã · ${new Date(r.createdAt).toLocaleString('vi-VN')}`
    + (ai ? ` · Gemini (${ai.model})` : '');

  const mf = r.marketFlow;
  $('pk-market').innerHTML = `
    <div class="pk-market-stats">
      ${r.market ? `<span>VN-Index <b class="${dirClass(r.market.changePct)}">${fmt(r.market.close)} (${signed(r.market.changePct)}%)</b> · ${{ up: 'xu hướng tăng', down: 'xu hướng giảm', sideways: 'đi ngang' }[r.market.trend] || ''}</span>` : ''}
      ${mf ? `<span>${mf.floor}: <b class="up">${mf.advancers} tăng</b> / <b class="down">${mf.decliners} giảm</b></span>
      <span>Khối ngoại toàn sàn <b class="${dirClass(mf.foreign.netVal)}">${signed(mf.foreign.netVal / 1e9, 0)} tỷ</b></span>` : ''}
    </div>
    ${ai?.marketView ? `<div class="pk-market-view"><b>✦ Gemini nhận định thị trường:</b> ${esc(ai.marketView)}</div>` : ''}
    ${r.ai?.error ? `<div class="pk-market-view"><span class="down">AI lỗi: ${esc(r.ai.error)}</span> Danh sách bên dưới xếp theo điểm hệ thống. Bấm "Gemini đánh giá lại" để thử lại — tool tự chuyển sang nhà cung cấp AI khác nếu bạn đã thêm key.</div>` : ''}
    ${r.hotSectors?.length ? `<div class="pk-line"><b>Ngành đang được mua (5 phiên):</b> ${r.hotSectors.map((s) => `<span class="tag ${s.net > 0 ? 'up' : 'ref'}">${s.rank}. ${esc(s.name)} ${signed(s.net / 1e9, 0)} tỷ</span>`).join(' ')}</div>` : ''}
    ${ai?.note ? `<div class="pk-line"><b>Quản lý vốn:</b> ${esc(ai.note)}</div>` : ''}`;

  // Ghép đánh giá Gemini vào từng ứng viên; xếp theo thứ tự Gemini, mã bị loại để riêng
  const pickBy = new Map((ai?.picks || []).map((p, i) => [p.symbol, { ...p, order: i }]));
  const rows = r.candidates.map((c, i) => ({ c, p: pickBy.get(c.symbol), order: pickBy.get(c.symbol)?.order ?? 100 + i }));
  rows.sort((x, y) => x.order - y.order);
  const kept = rows.filter((x) => x.p?.verdict !== 'LOAI');
  const rejected = rows.filter((x) => x.p?.verdict === 'LOAI');

  renderPickSummary(kept);
  renderSectorPicks(r);
  $('pk-list').innerHTML = kept.length ? kept.map((x, i) => pickCard(x.c, x.p, i + 1)).join('')
    : r.candidates.length ? '<div class="card pk-empty">Gemini không chọn mã nào đáng mua lúc này. Xem danh sách đã loại bên dưới.</div>'
    : noPicksCard(r);

  $('pk-rejected').hidden = !rejected.length;
  $('pk-rejected-count').textContent = `(${rejected.length} mã)`;
  $('pk-rejected-list').innerHTML = rejected.map(({ c, p }) => `
    <div class="pk-rej-row">
      <b>${esc(c.symbol)}</b>
      <span>${esc(p.mainRisk || p.thesis)}</span>
      <button type="button" class="btn btn-glass btn-xs" data-sym="${esc(c.symbol)}">Xem</button>
    </div>`).join('');
}

// Không có mã nào qua bộ lọc: nói rõ bị loại ở bước nào và vì sao (Gemini chưa được chạy trong trường hợp này)
function noPicksCard(r) {
  const fn = r.funnel || {};
  const steps = [
    ['liquidity', `thanh khoản đều ≥ 5 tỷ/ngày`],
    ['quality', 'cơ bản tốt (có lãi, ROE ≥ 12%, nợ thấp…)'],
    ['sector', 'thuộc ngành đang được mua ròng'],
    ['trend', 'xu hướng mạnh (điểm ≥ 70, trên MA200, không cảnh báo rủi ro)'],
  ];
  const k = steps.findIndex(([key]) => fn[key] === 0);
  const prev = k > 0 ? fn[steps[k - 1][0]] : r.scanned;
  const where = k >= 0
    ? `Có ${prev} mã qua bước trước nhưng <b>không mã nào ${steps[k][1]}</b>.`
    : 'Không mã nào qua đủ các bước lọc.';
  const sectorHint = k >= 0 && steps[k][0] === 'sector'
    ? ' Dòng tiền 5 phiên đang rút khỏi các ngành lớn; các ngành còn được mua ròng hầu như không có mã đạt chuẩn cơ bản và thanh khoản.' : '';
  const rej = r.deepRejected || [];
  const mode = r.isCounterTrend ? 'chế độ cổ phiếu ngược dòng' : r.isDeepDipMode ? 'chế độ gom hàng giá trị' : null;
  return `<section class="card pk-empty pk-none">
    <h3>Hôm nay không có mã nào đủ điều kiện mua mới</h3>
    <p>${where}${sectorHint}</p>
    ${mode ? `<p>Hệ thống đã thử ${esc(mode)} và phân tích sâu ${r.shortlisted} mã, nhưng ${rej.length ? 'đều bị loại' : 'không mã nào đạt'}:</p>` : ''}
    ${rej.length ? `<ul class="pk-none-list">${rej.map((x) => `<li><a href="#${esc(x.symbol)}" class="pf-sym" data-sym="${esc(x.symbol)}"><b>${esc(x.symbol)}</b></a> <span class="muted">${esc(x.reason)}</span></li>`).join('')}</ul>` : ''}
    <p class="muted small">Đứng ngoài khi không có tín hiệu cũng là một quyết định: bộ đo 4 năm cho thấy mua trong pha thị trường yếu cho kết quả kém hơn rõ rệt. Các mã điểm cao vẫn được theo dõi trong Bảng quét để vào khi điều kiện đủ.</p>
    <div class="picks-actions"><button type="button" class="btn btn-secondary btn-sm" id="pk-open-scan">Xem Bảng quét · Điểm cao</button></div>
  </section>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#pk-open-scan')) {
    if (window.matchMedia('(max-width: 1023px)').matches) setMobileTab('watchlist');
    $('side-tab-scan')?.click();
    document.querySelector('.btn-scan-pill[data-flt="TOP10"]')?.click();
  }
});

// Hành động ngay theo kết luận của Gemini và vị trí giá so với vùng mua
const PICK_ACTION = {
  MUA: ['Mua ngay', 'up'], MUA_THAM_DO: ['Mua thăm dò', 'up'], CHO_DIEM_MUA: ['Đặt lệnh chờ', 'ref'],
};

/** Tỷ trọng theo rủi ro: chạm cắt lỗ mất ~1% tổng vốn, tối đa 20%; mua thăm dò / chờ điểm mua dùng một nửa. */
function pickWeight(entry, stop, verdict) {
  if (!entry || !stop || stop >= entry) return 0.05;
  const w = Math.min(0.2, 0.01 / ((entry - stop) / entry));
  return verdict === 'MUA' ? w : w / 2;
}

// Kỳ vọng thống kê của nhóm điểm (expectancy.js): TB hơn rổ, khoảng p10–p90, tỷ lệ thắng rổ
function expCell(e) {
  const x = e?.h20;
  if (!x) return '<span class="muted small">chưa có</span>';
  return `<b class="${dirClass(x.meanExcess)}">${signed(x.meanExcess * 100, 1)}%</b> <span class="muted small">so rổ</span>
    <div class="muted small">${signed(x.p10 * 100, 0)}% … ${signed(x.p90 * 100, 0)}% · thắng ${Math.round(x.pBeat * 100)}%${x.significant ? '' : ' · chưa ý nghĩa'}</div>`;
}

function renderPickSummary(kept) {
  const el = $('pk-summary');
  el.hidden = !kept.length;
  if (!kept.length) return;
  const cap = capitalM() * 1e6;
  const rows = kept.map(({ c, p }, i) => {
    const verdict = p?.verdict || (c.recommendation.code === 'BUY' ? 'MUA' : 'CHO_DIEM_MUA');
    const entry = p?.entryZone || (c.plan ? { from: c.plan.support, to: c.close } : null);
    const stop = p?.stopLoss ?? c.plan?.stopLoss;
    const target = p?.target ?? c.plan?.target;
    let [act, tone] = PICK_ACTION[verdict] || PICK_ACTION.CHO_DIEM_MUA;
    // Giá đã nằm trong vùng mua thì lệnh chờ có thể khớp ngay
    const inZone = entry && c.close >= entry.from && c.close <= entry.to;
    const gap = entry && c.close > entry.to ? (entry.to / c.close - 1) * 100 : null;
    const when = verdict === 'CHO_DIEM_MUA'
      ? (inZone ? 'giá đang trong vùng mua' : gap != null ? `chờ giá về ${fmt(entry.to)} (${signed(gap, 1)}%)` : 'chờ tín hiệu')
      : inZone ? 'giá đang trong vùng mua' : entry ? `trong vùng ${fmt(entry.from)}–${fmt(entry.to)}` : '';
    const ref = entry ? entry.to : c.close;
    const w = pickWeight(ref, stop, verdict);
    const sh = cap ? Math.floor((cap * w) / (ref * 1000) / 100) * 100 : 0;
    return `<tr>
      <td>${i + 1}</td>
      <td><a href="#${c.symbol}" class="pf-sym" data-sym="${esc(c.symbol)}"><b>${esc(c.symbol)}</b></a><div class="muted small">${esc(c.sector?.name || '')}</div></td>
      <td>${fmt(c.close)} <span class="${dirClass(c.changePct)} small">${signed(c.changePct)}%</span></td>
      <td><span class="st-badge ${tone}">${act}</span>${p ? ` <span class="muted small">${p.confidence}%</span>` : ''}<div class="small muted">${esc(when)}</div></td>
      <td>${entry ? `${fmt(entry.from)}–${fmt(entry.to)}` : '–'}</td>
      <td class="down">${fmt(stop)}</td><td class="up">${fmt(target)}${target && ref ? `<div class="small">${signed((target / ref - 1) * 100, 1)}%${p?.horizonDays ? ` · ${p.horizonDays} phiên` : ''}</div>` : ''}</td>
      <td>${expCell(c.expectation)}</td>
      <td>${Math.round(w * 1000) / 10}%${cap ? ` · <b>${sh.toLocaleString('vi-VN')} cp</b> <span class="muted small">≈ ${fmtBig(sh * ref * 1000)}</span>` : ''}</td>
    </tr>`;
  }).join('');
  const now = kept.filter(({ p }) => p?.verdict === 'MUA' || p?.verdict === 'MUA_THAM_DO').length;
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:6px"><div>
      <h3>📋 Gợi ý cổ phiếu</h3>
      <div class="muted small">${now ? `${now} mã có thể mua ngay / mua thăm dò` : 'Chưa có mã nào nên mua ngay: tất cả đang chờ giá về vùng mua'} · ${kept.length} mã đạt đủ 4 lớp lọc và được Gemini giữ lại${cap ? ` · vốn ${fmtBig(cap)}` : ' · nhập vốn ở trang mã bất kỳ (ô "Tổng vốn") để xem số cổ phiếu'}</div>
    </div></div>
    <div class="tbl-wrap"><table class="tbl pk-sum-table"><thead><tr><th>#</th><th>Mã · ngành</th><th>Giá</th><th>Hành động</th><th>Vùng mua</th><th>Cắt lỗ</th><th>Mục tiêu (AI)</th><th>Thống kê 20 phiên</th><th>Tỷ trọng · số cp</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted small" style="margin:6px 0 0">"Thống kê 20 phiên" = trong 4 năm, các mã cùng nhóm điểm xếp hạng hơn rổ chia đều trung bình bao nhiêu sau 20 phiên và khoảng 80% số lần (p10–p90); đây là con số có căn cứ, mục tiêu của AI chỉ là ý kiến và sẽ được chấm lại.
      Tỷ trọng tính theo rủi ro: nếu chạm cắt lỗ chỉ mất ~1% tổng vốn (tối đa 20%/mã); mua thăm dò và đặt lệnh chờ dùng một nửa. "Đặt lệnh chờ" = đặt lệnh mua giới hạn ở vùng mua, không mua đuổi giá hiện tại.</p>`;
}

const PICK_STATUS = {
  PICK: ['Đã chọn', 'up', 'Đạt đủ 4 lớp lọc, có trong danh sách gợi ý'],
  TREND_OK: ['Đủ điều kiện', 'up', 'Đạt đủ điều kiện nhưng không nằm trong nhóm điểm chung cao nhất / bị loại sau phân tích sâu'],
  WAIT_TREND: ['Chờ xu hướng', 'ref', 'Cơ bản tốt, ngành đang được mua, nhưng xu hướng giá chưa đủ mạnh'],
};

function renderSectorPicks(r) {
  const el = $('pk-sectors');
  const list = r.sectorPicks || [];
  el.hidden = !list.length;
  if (!list.length) return;
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:6px"><div>
      <h3>🏭 Gợi ý theo ngành đang được mua</h3>
      <div class="muted small">Ngành có dòng tiền ròng 5 phiên dương hoặc top 5 ngành · mỗi ngành tối đa 4 mã thanh khoản đều ≥ 5 tỷ/ngày và cơ bản tốt, xếp theo điểm chung (xu hướng + chất lượng)</div>
    </div></div>
    <div class="pk-sec-grid">${list.map((s) => `
      <div class="pk-sec">
        <div class="pk-sec-head"><b>${s.rank}. ${esc(s.name)}</b><span class="${dirClass(s.net)}">${signed(s.net / 1e9, 0)} tỷ</span></div>
        ${s.stocks.length ? `<ul>${s.stocks.map((x) => {
          const [lb, tone, tip] = PICK_STATUS[x.status];
          return `<li><a href="#${x.symbol}" class="pf-sym" data-sym="${esc(x.symbol)}"><b>${esc(x.symbol)}</b></a>
            <span>${fmt(x.close)} <span class="${dirClass(x.changePct)} small">${signed(x.changePct)}%</span></span>
            <span class="st-badge ${tone}" title="${esc(tip)}">${lb}</span>
            <span class="muted small">xu hướng ${x.rankScore ?? '–'} · chất lượng ${x.quality ?? '–'}${x.waitReason ? ` · ${esc(x.waitReason)}` : ''}</span></li>`;
        }).join('')}</ul>${s.more ? `<div class="muted small">+${s.more} mã khác đạt điều kiện</div>` : ''}`
          : '<div class="muted small">Không có mã nào trong ngành đạt thanh khoản đều và cơ bản tốt.</div>'}
      </div>`).join('')}</div>`;
}

function pickCard(c, p, rank) {
  const pct = (x) => (x == null ? '' : `${signed(((x - c.close) / c.close) * 100, 1)}%`);
  const tone = p ? PICK_TONE[p.verdict] : (c.recommendation.code === 'BUY' || c.recommendation.code === 'ACCUMULATE' ? 'up' : 'ref');
  const label = p ? p.verdictLabel : c.recommendation.label;
  const entry = p?.entryZone || (c.plan ? { from: c.plan.support, to: c.close } : null);
  const stop = p?.stopLoss ?? c.plan?.stopLoss;
  const target = p?.target ?? c.plan?.target;
  const mid = entry ? (entry.from + entry.to) / 2 : c.close;
  const rr = stop != null && target != null && mid > stop ? (target - mid) / (mid - stop) : null;
  const f = c.fundamentals || {};
  const watching = state.watchlist.some((w) => w.symbol === c.symbol);
  return `
    <section class="card pk-card v-${p?.verdict || ''}">
      <div class="pk-top">
        <div>
          <div class="pk-sym"><span class="pk-rank">#${rank}</span>${esc(c.symbol)}<span class="tag">${esc(c.exchange)}</span></div>
          <div class="pk-name">${esc(c.name)}</div>
        </div>
        <div class="pk-price"><b>${fmt(c.close)}</b><span class="${dirClass(c.changePct)}">${signed(c.changePct)}%</span></div>
      </div>
      <div><span class="pk-verdict ${tone}">${esc(label)}${p ? ` · ${p.confidence}%` : ''}</span></div>
      <div class="pk-tags">${c.trendPick ? '<span class="pk-tag" style="background:rgba(46,189,133,0.15);color:#2ebd85;border:1px solid #2ebd85;font-weight:700" title="Cổ phiếu gần đỉnh 52 tuần và biến động thấp theo quy tắc Trend Pick 8 năm">★ TREND PICK</span>' : ''}${c.setups.map((s) => `<span class="pk-tag" title="${esc(s.desc)}">${esc(s.label)}</span>`).join('')}</div>
      <p class="pk-thesis">${esc(p?.thesis || c.recommendation.desc)}</p>
      <div class="pk-levels">
        <div class="pk-lv"><div class="k">Vùng mua</div><div class="v">${entry ? `${fmt(entry.from)}–${fmt(entry.to)}` : '–'}</div></div>
        <div class="pk-lv"><div class="k">Cắt lỗ</div><div class="v down">${fmt(stop)}</div><div class="p">${pct(stop)}</div></div>
        <div class="pk-lv"><div class="k">Mục tiêu</div><div class="v up">${fmt(target)}</div><div class="p">${pct(target)}</div></div>
        <div class="pk-lv"><div class="k">Lời / Lỗ</div><div class="v ${rr >= 2 ? 'up' : rr < 1.2 ? 'down' : ''}">${rr ? `${fmt(rr, 1)} lần` : '–'}</div><div class="p">${esc(p?.horizon || '')}</div></div>
      </div>
      ${p?.trigger ? `<div class="pk-line"><b>Điều kiện mua:</b> ${esc(p.trigger)}</div>` : ''}
      ${p?.mainRisk ? `<div class="pk-line"><b>Rủi ro:</b> ${esc(p.mainRisk)}</div>` : ''}
      <details class="pk-details-drawer">
        <summary class="pk-details-toggle">🔍 Xem chi tiết BCTC &amp; Chỉ số định lượng ▾</summary>
        <div class="pk-drawer-content">
          ${c.quality ? `<div class="pk-quality"><b>Đánh giá chất lượng cơ bản</b> ${c.quality.score != null ? `<span class="muted small">· chất lượng ${c.quality.score}/100${c.combined != null ? ` · điểm chung ${c.combined}` : ''}</span>` : ''}
            <ul>${c.quality.checks.map((k) => `<li class="${k.ok ? 'up' : 'down'}">${k.ok ? '✓' : '✕'} ${esc(k.label)}</li>`).join('')}
            ${c.sector ? `<li class="${c.sector.pass ? 'up' : 'down'}">${c.sector.pass ? '✓' : '✕'} ${esc(c.sector.label)}</li>` : ''}
            ${c.liquidity ? `<li class="${c.liquidity.pass ? 'up' : 'down'}">${c.liquidity.pass ? '✓' : '✕'} Thanh khoản TB ${fmt(c.liquidity.avg / 1e9, 1)} tỷ/phiên, ${c.liquidity.okDays}/${c.liquidity.days} phiên ≥ 5 tỷ (phiên gần nhất ${fmt(c.liquidity.last / 1e9, 1)} tỷ)</li>` : ''}</ul></div>` : ''}
          <div class="pk-stats">
            <span>Điểm HT ${signed(c.total, 0)}</span>
            ${c.ranking ? `<span title="Điểm xếp hạng 4 yếu tố (0–100)">Xếp hạng ${c.ranking.score}</span>` : ''}
            ${c.expectation?.h20 ? `<span title="Lịch sử 4 năm của nhóm điểm này: hơn rổ TB sau 20 phiên">📊 Thống kê 20 phiên: ${signed(c.expectation.h20.meanExcess * 100, 1)}% so rổ</span>` : ''}
            ${c.foreign ? `<span>NN 20 phiên ${signed(c.foreign.net20 / 1e9, 1)} tỷ</span>` : ''}
            ${f.pe != null ? `<span>P/E ${fmt(f.pe, 1)}</span>` : ''}
            ${f.roe != null ? `<span>ROE ${fmtPct(f.roe)}</span>` : ''}
            ${f.profitGrowthTTM != null ? `<span>LN 4Q ${fmtPct(f.profitGrowthTTM, 0)}</span>` : ''}
          </div>
        </div>
      </details>
      <div class="pk-foot">
        <button type="button" class="btn btn-glass btn-sm" data-watch="${esc(c.symbol)}" ${watching ? 'disabled' : ''}>${watching ? '✓ Đang theo dõi' : '+ Theo dõi'}</button>
        <button type="button" class="btn btn-primary btn-sm" data-sym="${esc(c.symbol)}">Phân tích chi tiết →</button>
      </div>
    </section>`;
}

$('picks-btn')?.addEventListener('click', showPicks);
$('pk-run-btn')?.addEventListener('click', async () => {
  await api('/api/screener/run', { method: 'POST' }).catch((err) => showToast(err.message, 'error'));
  loadPicks();
});
$('pk-ai-btn')?.addEventListener('click', async () => {
  await api('/api/screener/ai', { method: 'POST' }).catch((err) => showToast(err.message, 'error'));
  loadPicks();
});
$('picks')?.addEventListener('click', async (e) => {
  const w = e.target.closest('[data-watch]');
  if (!w) return;
  w.disabled = true;
  await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: w.dataset.watch }) });
  showToast(`Đã thêm ${w.dataset.watch} vào danh mục theo dõi`, 'success');
  w.textContent = '✓ Đang theo dõi';
  loadWatchlist();
});

function renderAi(r) {
  setFold('sec-ai', r.decisionLabel, DECISION_TONE[r.decision] || '');
  const close = state.current?.price.close;
  const stale = close != null && r.price !== close;
  const list = (title, items, cls = '') => (items?.length
    ? `<div><h4 class="${cls}">${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  $('ai-body').innerHTML = `
    <div class="ai-head">
      <span class="recommendation-badge ${r.decision}">${esc(r.decisionLabel)}</span>
      <span class="muted small">${esc(r.model)} · ${new Date(r.createdAt).toLocaleString('vi-VN')} · Tại giá ${fmt(r.price)}${stale ? ' (giá đã đổi, nên phân tích lại)' : ''}</span>
    </div>
    <p class="ai-summary">${esc(r.summary)}</p>
    <div class="ai-actions">
      <div class="ai-box"><h4>Nếu chưa có cổ phiếu</h4>${esc(r.forNewBuyers)}</div>
      <div class="ai-box"><h4>Nếu đang nắm giữ</h4>${esc(r.forHolders)}</div>
    </div>
    ${r.positionSizing ? `<div class="ai-box" style="margin-bottom:14px"><h4>Quản lý vốn & tỷ trọng</h4>${esc(r.positionSizing)}</div>` : ''}
    <div class="ai-lists">
      ${list('▲ Luận điểm ủng hộ', r.bullCase, 'up')}
      ${list('▼ Rủi ro / Phản biện', r.bearCase, 'down')}
      ${list('Nhận định từ tin tức', r.newsInsights)}
      ${list('Sự kiện sắp tới (Catalyst)', r.catalysts)}
      ${list('Tín hiệu cần theo dõi', r.watchItems)}
      ${list('Dữ liệu còn thiếu', r.dataGaps)}
    </div>
    ${r.ruleScoreComment ? `<div class="ai-box" style="margin-top:14px"><h4>So với điểm theo quy tắc</h4>${esc(r.ruleScoreComment)}</div>` : ''}
    <p class="ai-note">AI có thể sai hoặc suy diễn quá mức. Đối chiếu với dữ liệu định lượng bên dưới trước khi ra quyết định. ${r.tokens ? `${r.tokens.toLocaleString('vi-VN')} tokens · ` : ''}${Math.round(r.durationMs / 1000)}s</p>
  `;
}

$('btn-copy-ai')?.addEventListener('click', () => {
  const body = $('ai-body')?.innerText;
  if (!body) {
    showToast('Chưa có nhận định AI nào để sao chép', 'info');
    return;
  }
  navigator.clipboard.writeText(body);
  showToast('Đã sao chép nhận định AI vào clipboard!', 'success');
});

// ---------- Cảnh báo & Drawer ----------
async function loadAlerts() {
  const alerts = await api('/api/alerts').catch(() => []);
  const unread = alerts.filter((a) => !a.read).length;
  $('alerts-count').hidden = !unread;
  $('alerts-list').innerHTML = alerts.length ? alerts.map((a) => `
    <li class="${a.read ? '' : 'unread'}" data-sym="${esc(a.symbol)}">
      <div style="font-size:13px">${a.type === 'opportunity' ? '🎯 ' : ''}<b>${esc(a.symbol)}</b>: ${esc(a.message)}</div>
      <div class="meta">${new Date(a.time).toLocaleString('vi-VN')}</div>
    </li>
  `).join('') : '<li class="muted" style="padding:14px">Chưa có cảnh báo nào trong hệ thống.</li>';
}

$('alerts-btn')?.addEventListener('click', async () => {
  $('drawer').hidden = false;
  await api('/api/alerts/read', { method: 'POST' });
  $('alerts-count').hidden = true;
});

$('drawer-close')?.addEventListener('click', () => {
  $('drawer').hidden = true;
  loadAlerts();
});

$('alerts-list')?.addEventListener('click', (e) => {
  const li = e.target.closest('[data-sym]');
  if (li) {
    $('drawer').hidden = true;
    analyze(li.dataset.sym);
  }
});

$('btn-create-test-alert')?.addEventListener('click', async () => {
  const sym = state.current?.symbol || 'FPT';
  await api('/api/alerts/test', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
  await loadAlerts();
  showToast(`Đã tạo cảnh báo test cho ${sym}`, 'success');
});

// ---------- Menu Test Tools Dropdown ----------
const toolsDropdown = $('tools-dropdown');
$('tools-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsDropdown.classList.toggle('open');
});

document.addEventListener('click', () => toolsDropdown?.classList.remove('open'));

$('btn-test-alert')?.addEventListener('click', async () => {
  toolsDropdown.classList.remove('open');
  const sym = state.current?.symbol || 'HPG';
  await api('/api/alerts/test', {
    method: 'POST',
    body: JSON.stringify({ symbol: sym, message: `[TEST] ${sym} có biến động giá vượt ngưỡng thử nghiệm!` }),
  });
  await loadAlerts();
  showToast(`Đã bắn cảnh báo thử nghiệm cho ${sym}`, 'success');
});

$('btn-copy-json')?.addEventListener('click', () => {
  toolsDropdown.classList.remove('open');
  if (!state.current) {
    showToast('Hãy chọn 1 mã để phân tích trước khi copy JSON!', 'info');
    return;
  }
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã sao chép toàn bộ JSON vào bộ nhớ tạm!', 'success');
});

$('btn-quick-scan')?.addEventListener('click', async () => {
  toolsDropdown.classList.remove('open');
  showToast('Đang quét danh mục…', 'info');
  await api('/api/scan', { method: 'POST' });
  await Promise.all([loadWatchlist(), loadAlerts(), loadMovers()]);
  showToast('Đã quét xong toàn bộ danh mục!', 'success');
});

const pct = (v, d = 1) => (v == null ? '–' : `${signed(v * 100, d)}%`);

// ---------- Hội đồng đầu tư ----------
const CM = { timer: null };
const WINNER = { PHE_MUA: ['up', 'Phe mua thắng'], PHE_BAN: ['down', 'Phe bán thắng'], CAN_BANG: ['ref', 'Hai phe cân bằng'] };

async function loadCommittee(a) {
  clearTimeout(CM.timer);
  $('cm-card').hidden = a.isIndex;
  if (a.isIndex) return;
  $('cm-btn').disabled = !state.ai.enabled;
  if (!state.ai.enabled) {
    $('cm-body').innerHTML = '<p class="muted" style="padding:6px 0">Cần ít nhất một API key AI (GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY…) trong file .env để triệu tập hội đồng (xem README).</p>';
    return;
  }
  const s = await api(`/api/committee/${a.symbol}`).catch(() => null);
  if (state.current?.symbol !== a.symbol) return;
  renderCommittee(s, a);
  // Mỗi mã/phiên tự chạy quy trình Gemini + hội đồng một lần nếu chưa có quyết định cuối của phiên này
  const r = s?.result;
  const key = `${a.symbol}:${a.price.date}`;
  if (s?.status !== 'running' && !(r?.final && r.priceDate === a.price.date) && !state.aiAuto.has(key)) {
    state.aiAuto.add(key);
    runAiFor(a, false);
  }
}

function renderCommittee(s, a) {
  const running = s?.status === 'running';
  $('cm-btn').disabled = running || !state.ai.enabled;
  $('ai-btn').disabled = running;
  if (running) {
    const stage = `${s.step ? `Bước ${s.step}/${s.steps || 4}: ` : ''}${s.stage || 'Đang họp'}`;
    const changed = state.aiRunning !== a.symbol || state.cmStage !== stage;
    state.aiRunning = a.symbol;
    state.cmStage = stage;
    if (changed) applyAiToDecision(a, state.aiResult);
    $('cm-body').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
      <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div>
      <span>${esc(stage)}… (thường mất 1–3 phút)</span></div>`;
    if (s.step <= 2) {
      $('ai-body').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
        <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div>
        <span>${esc(stage)}…</span></div>`;
    }
    clearTimeout(CM.timer);
    CM.timer = setTimeout(async () => {
      const next = await api(`/api/committee/${a.symbol}`).catch(() => null);
      if (state.current?.symbol === a.symbol) renderCommittee(next, a);
    }, 2500);
    return;
  }
  // Quy trình đã xong (hoặc lỗi): cập nhật Gemini, thẻ quyết định và tóm tắt theo kết quả mới
  const wasRunning = state.aiRunning === a.symbol;
  if (wasRunning) state.aiRunning = null;
  if (s?.status === 'error') state.aiError = { symbol: a.symbol, message: s.error };
  if (s?.result) {
    state.cmResult = s.result;
    if (s.result.gemini) renderAi(s.result.gemini);
    applyAiToDecision(a, s.result.gemini || state.aiResult);
    if (wasRunning) loadWatchlist();
  } else if (wasRunning) applyAiToDecision(a, state.aiResult);
  const err = s?.status === 'error' ? `<p class="error" style="padding:10px 0">Lần họp gần nhất lỗi: ${esc(s.error)}</p>` : '';
  const r = s?.result;
  if (!r) {
    $('cm-body').innerHTML = `${err}<p class="muted" style="padding:6px 0">Chưa có phiên họp nào cho ${esc(a.symbol)}. Bấm <b>Triệu tập hội đồng</b>: phe mua và phe bán lập luận độc lập, sau đó giám đốc đầu tư bác bỏ luận điểm thiếu căn cứ và ra quyết định.</p>`;
    return;
  }
  const v = r.verdict;
  const [wTone, wLabel] = WINNER[v.winner] || WINNER.CAN_BANG;
  setFold('sec-committee', `${v.decisionLabel} · ${wLabel.toLowerCase()}`, DECISION_TONE[v.decision] || '');
  const close = a.price.close;
  const stale = r.price !== close;
  const ptsList = (items, cls) => `<ul class="cm-points">${items.map((p) => `<li><span class="cm-lv ${p.level === 'CAO' ? cls : ''}">${p.level === 'CAO' ? 'Mạnh' : 'Vừa'}</span>${esc(p.text)}</li>`).join('')}</ul>`;
  const list = (title, items, cls = '') => (items?.length ? `<div><h4 class="${cls}">${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  $('cm-body').innerHTML = `${err}
    <div class="ai-head">
      <span class="recommendation-badge ${v.decision}">${esc(v.decisionLabel)}</span>
      <span class="tag ${wTone}">${wLabel}</span>
      <span class="muted small">${esc(r.model)} · ${new Date(r.createdAt).toLocaleString('vi-VN')} · tại giá ${fmt(r.price)}${stale ? ' (giá đã đổi, nên họp lại)' : ''} · điểm hệ thống ${signed(r.ruleScore.total, 0)} (${esc(r.ruleScore.label)})</span>
    </div>
    <p class="ai-summary">${esc(v.debateSummary)}</p>
    <div class="cm-debate">
      <div class="cm-side cm-bull"><h4 class="up">▲ Phe mua</h4>${ptsList(r.bull.points, 'up')}
        ${r.bull.technical ? `<p><b>Kỹ thuật:</b> ${esc(r.bull.technical)}</p>` : ''}
        ${r.bull.fundamental ? `<p><b>Cơ bản:</b> ${esc(r.bull.fundamental)}</p>` : ''}
        <div class="ai-lists">${list('Chất xúc tác', r.bull.catalysts)}${list('Kịch bản sai', r.bull.invalidation, 'down')}</div>
      </div>
      <div class="cm-side cm-bear"><h4 class="down">▼ Phe bán</h4>${ptsList(r.bear.points, 'down')}
        ${r.bear.technical ? `<p><b>Kỹ thuật:</b> ${esc(r.bear.technical)}</p>` : ''}
        ${r.bear.valuation ? `<p><b>Định giá:</b> ${esc(r.bear.valuation)}</p>` : ''}
        ${r.bear.riskMetrics ? `<p><b>Chỉ số rủi ro:</b> ${esc(r.bear.riskMetrics)}</p>` : ''}
        <div class="ai-lists">${list('Tín hiệu bác bỏ luận điểm bán', r.bear.disproof, 'up')}</div>
      </div>
    </div>
    <h4 style="margin:16px 0 8px">⚖️ Thẩm định của giám đốc đầu tư</h4>
    <div class="ai-lists">
      ${list('Chấp nhận từ phe mua', v.acceptedBull, 'up')}
      ${list('Chấp nhận từ phe bán', v.acceptedBear, 'down')}
      ${list('Bác bỏ (phe mua)', v.rejectedBull, 'muted')}
      ${list('Bác bỏ (phe bán)', v.rejectedBear, 'muted')}
    </div>
    <div class="ai-actions" style="margin-top:12px">
      <div class="ai-box"><h4>Bằng chứng lịch sử (backtest)</h4>${esc(v.backtestView)}${r.backtest ? `<div class="muted small" style="margin-top:6px">${esc(r.backtest.brief)}</div>` : ''}</div>
      <div class="ai-box"><h4>Đánh giá rủi ro</h4>${esc(v.riskReview)}${r.risk ? `<div class="muted small" style="margin-top:6px">Biến động năm ${pct(r.risk.volatility)} · VaR95 ${pct(-r.risk.var95)} · CVaR95 ${pct(-r.risk.cvar95)} · beta ${fmt(r.risk.beta)}</div>` : ''}</div>
    </div>
    <div class="ai-actions">
      <div class="ai-box"><h4>Hành động</h4>${esc(v.action)}</div>
      <div class="ai-box"><h4>Tỷ trọng & giải ngân</h4>${esc(v.positionSizing)}</div>
    </div>
    <div class="ai-lists">${list('Điều kiện để đổi quyết định', v.conditionsToChange)}</div>
    <p class="ai-note">3 lượt gọi Gemini · ${r.tokens ? `${r.tokens.toLocaleString('vi-VN')} tokens · ` : ''}${Math.round(r.durationMs / 1000)}s. AI chỉ dùng để soát rủi ro: trong đo kiểm, lệnh mua của AI chưa thắng rổ, độ tin cậy AI tự chấm chưa khớp thực tế nên đã ẩn.</p>`;
}

$('cm-btn')?.addEventListener('click', () => state.current && runAiFor(state.current, false));

// ---------- Danh mục đầu tư ----------
function showPortfolio() {
  ['marketview', 'empty', 'error', 'report', 'loading', 'picks', 'rankview', 'sectorview', 'autoview'].forEach((id) => ($(id).hidden = true));
  $('auto-btn')?.classList.remove('on');
  markMobileView('analyze', 'more');
  $('sector-btn')?.classList.remove('on');
  $('picks-btn')?.classList.remove('on');
  $('rank-btn')?.classList.remove('on');
  $('portfolio').hidden = false;
  $('pf-btn')?.classList.add('on');
  history.replaceState(null, '', '#danh-muc');
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  for (const form of [$('pf-form'), $('pf-cash-form')]) if (form && !form.date.value) form.date.value = today;
  loadPortfolio();
}

async function loadPortfolio() {
  $('pf-body').innerHTML = '<div class="card muted">Đang tải giá và tính toán danh mục…</div>';
  try {
    renderPortfolio(await api('/api/portfolio'));
  } catch (err) {
    $('pf-body').innerHTML = `<div class="card error">${esc(err.message)}</div>`;
    return;
  }
  loadHoldingAdvice();
}

// Phân tích rủi ro từng mã đang nắm: cùng cách tính với bản tin Telegram 15:10 (bán / xem lại / giữ / mua thêm + rủi ro)
const ADVICE_TONE = { 'BÁN': 'down', 'XEM LẠI': 'down', 'MUA THÊM': 'up', 'GIỮ': 'ref' };
function adviceRow(x) {
  return `
      <div class="pk-none" style="padding:12px 0;border-top:1px solid var(--border)">
        <div style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline">
          <a href="#${esc(x.symbol)}" class="pf-sym" data-sym="${esc(x.symbol)}"><b>${esc(x.symbol)}</b></a>
          <span class="num">${fmt(x.close)}</span>
          ${x.qty ? `<span class="muted small">${fmt(x.qty, 0)} cp · vốn ${fmt(x.avgCost)}</span>` : ''}
          ${x.pnlPct != null ? `<span class="${dirClass(x.pnlPct)}">${x.pnlPct >= 0 ? 'lãi' : 'lỗ'} ${signed(x.pnlPct * 100)}%</span>` : ''}
          ${x.held != null ? `<span class="muted small">đã giữ ${x.held}/${x.N} phiên</span>` : ''}
          <span class="st-badge ${ADVICE_TONE[x.action] || ''}" style="margin-left:auto">${esc(x.action)}</span>
        </div>
        <div class="small">${esc(x.why)}</div>
        ${x.risks.length ? `<ul class="pk-none-list">${x.risks.map((r) => `<li class="small">⚠️ ${esc(r)}</li>`).join('')}</ul>` : '<div class="muted small">Chưa thấy rủi ro đáng chú ý.</div>'}
      </div>`;
}

async function loadHoldingAdvice() {
  const el = $('pf-advice');
  if (!el) return;
  try {
    const d = await api('/api/portfolio/advice');
    if (!$('pf-advice')) return; // đã rời trang
    const rows = d.items.map(adviceRow).join('');
    el.innerHTML = `<div class="card-head"><div><h3>🔎 Phân tích rủi ro mã đang nắm</h3>
      <div class="muted small">Cùng cách tính với bản tin Telegram 15:10${d.breadth != null ? ` · độ rộng thị trường ${Math.round(d.breadth * 100)}% mã trên MA50${d.breadth < 0.5 ? ' (yếu: không mua thêm)' : ''}` : ''} · ${new Date(d.updatedAt).toLocaleTimeString('vi-VN')}</div></div></div>
      ${rows || '<p class="muted small">Chưa nắm giữ mã nào.</p>'}`;
  } catch (err) {
    if ($('pf-advice')) $('pf-advice').innerHTML = `<p class="down small">Không phân tích được: ${esc(err.message)}</p>`;
  }
}

function renderPortfolio(p) {
  const s = p.summary;
  const kpi = (k, v, cls = '') => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const symLink = (sym) => `<a href="#${sym}" class="pf-sym" data-sym="${sym}">${sym}</a>`;
  const rk = p.risk;
  const bh = p.behavior;

  const holdings = p.holdings.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>Mã</th><th>KL</th><th>Bán được</th><th>Giá vốn</th><th>Giá</th><th>Giá trị</th><th>Tỷ trọng</th><th>Lãi/lỗ*</th><th>%</th><th>Hôm nay</th><th>Điểm KT</th><th>Xu hướng</th></tr></thead><tbody>
      ${p.holdings.map((h) => `<tr class="${h.belowStop ? 'pf-alert' : ''}">
        <td>${symLink(h.symbol)}${h.belowStop ? ' <span class="down" title="Đóng cửa dưới ngưỡng thoát −15% giá vốn: bán phiên tới">⚠</span>' : ''}</td>
        <td>${fmt(h.qty, 0)}</td>
        <td>${fmt(h.sellable, 0)}${h.pending ? ` <span class="muted small" title="Chưa về tài khoản (T+2)">(+${fmt(h.pending, 0)} chờ về)</span>` : ''}</td>
        <td>${fmt(h.avgCost)}</td><td>${fmt(h.close)}</td><td>${fmtBig(h.marketValue)}</td><td>${fmt(h.weight * 100, 1)}%</td>
        <td class="${dirClass(h.unrealized)}">${fmtBig(h.unrealized)}</td><td class="${dirClass(h.unrealizedPct)}">${signed(h.unrealizedPct)}%</td>
        <td class="${dirClass(h.dayChange)}">${fmtBig(h.dayChange)}</td>
        <td class="${dirClass(h.tech?.score)}">${h.tech ? signed(h.tech.score, 0) : '–'}</td>
        <td>${esc(h.tech?.trend || '–')}${h.effectiveStop ? `<div class="muted small">ngưỡng thoát ${fmt(h.effectiveStop)}${h.heldSessions != null ? ` · đã giữ ${h.heldSessions}/${h.hold?.reviewAfter ?? 40} phiên` : ''}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small" style="margin-top:6px">* Lãi/lỗ tạm tính đã trừ phí bán ${fmt(p.fees.brokerage * 100, 2)}% và thuế ${fmt(p.fees.sellTax * 100, 2)}%. Giá vốn bình quân gồm phí mua.</p>`
    : '<p class="muted">Chưa có vị thế nào. Ghi lệnh mua ở form phía trên.</p>';

  const riskCard = rk ? `<section class="card"><div class="card-head"><h3>🩻 X-quang rủi ro danh mục</h3><span class="badge-subtle">${rk.days} phiên gần nhất</span></div>
    ${rk.warnings.map((w) => `<div class="warning">${esc(w)}</div>`).join('')}
    <div class="ai-levels" style="margin-top:10px">
      ${kpi('Số mã hiệu dụng', fmt(rk.concentration.effectiveN, 1))}
      ${kpi(`Lớn nhất (${rk.concentration.top})`, `${fmt(rk.concentration.topWeight * 100, 0)}%`)}
      ${kpi('Biến động năm', rk.volatility != null ? `${fmt(rk.volatility * 100, 1)}%` : '–')}
      ${kpi('VaR95 1 phiên', rk.var95 != null ? `${fmt(rk.var95 * 100, 1)}% · ${fmtBig(rk.var95Value)}` : '–', 'down')}
      ${kpi('CVaR95 1 phiên', rk.cvar95 != null ? `${fmt(rk.cvar95 * 100, 1)}% · ${fmtBig(rk.cvar95Value)}` : '–', 'down')}
      ${kpi('Sụt giảm tối đa 1 năm', pct(rk.maxDrawdown), 'down')}
      ${kpi('Beta với VN-Index', fmt(rk.beta))}
      ${kpi('Tương quan TB', fmt(rk.avgCorrelation))}
      ${kpi('Hệ số đa dạng hóa', fmt(rk.diversificationRatio))}
      ${rk.topPair ? kpi('Cặp tương quan nhất', `${rk.topPair.a}–${rk.topPair.b} ${fmt(rk.topPair.corr)}`) : ''}
    </div>
    <p class="muted small" style="margin-top:8px">VaR95: 95% số phiên trong năm qua không lỗ quá mức này với tỷ trọng hiện tại. Hệ số đa dạng hóa &gt; 1,3 là tốt.</p></section>` : '';

  const behaviorCard = bh ? `<section class="card"><div class="card-head"><h3>🪞 Chẩn đoán hành vi giao dịch</h3><span class="badge-subtle">${bh.closedCount} lệnh đã chốt</span></div>
    <div class="ai-levels">
      ${kpi('Tỷ lệ thắng', `${fmt(bh.winRate * 100, 0)}%`)}
      ${kpi('Lãi TB / Lỗ TB', `${bh.avgWinPct != null ? `+${fmt(bh.avgWinPct, 1)}%` : '–'} / ${bh.avgLossPct != null ? `${fmt(bh.avgLossPct, 1)}%` : '–'}`)}
      ${kpi('Giữ lệnh lãi / lỗ', `${bh.avgHoldWin ?? '–'} / ${bh.avgHoldLoss ?? '–'} ngày`)}
      ${kpi('Profit factor', fmt(bh.profitFactor))}
      ${kpi('Lãi đã chốt', fmtBig(bh.realized), dirClass(bh.realized))}
    </div>
    ${bh.insights.length ? `<ul class="pf-insights">${bh.insights.map((i) => `<li class="tone-${i.tone}">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="muted small">Chưa phát hiện thói quen bất lợi rõ ràng (cần ít nhất 4 lệnh đã chốt để đánh giá).</p>'}
    </section>` : '';

  const txs = p.transactions.length ? `<section class="card"><div class="card-head"><h3>📒 Nhật ký lệnh</h3><span class="badge-subtle">${p.transactions.length} lệnh</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>Lệnh</th><th>Mã</th><th>KL</th><th>Giá</th><th>Giá trị</th><th>Ghi chú</th><th></th></tr></thead><tbody>
    ${p.transactions.map((t) => `<tr><td>${t.date}</td><td class="${t.type === 'BUY' ? 'up' : 'down'}">${t.type === 'BUY' ? 'Mua' : 'Bán'}</td><td>${symLink(t.symbol)}</td>
      <td>${fmt(t.qty, 0)}</td><td>${fmt(t.price)}</td><td>${fmtBig(t.qty * t.price * 1000)}</td><td class="muted small">${esc(t.note)}</td>
      <td><button type="button" class="btn btn-glass btn-xs" data-del="${esc(t.id)}" title="Xóa lệnh">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    ${p.closed.length ? `<h4 style="margin:14px 0 6px">Lệnh bán đã chốt</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>Mã</th><th>KL</th><th>Giá vốn</th><th>Giá bán</th><th>Lãi/lỗ</th><th>%</th><th>Giữ</th></tr></thead><tbody>
      ${p.closed.map((c) => `<tr><td>${c.date}</td><td>${symLink(c.symbol)}</td><td>${fmt(c.qty, 0)}</td><td>${fmt(c.avgCost)}</td><td>${fmt(c.sellPrice)}</td>
        <td class="${dirClass(c.pnl)}">${fmtBig(c.pnl)}</td><td class="${dirClass(c.returnPct)}">${signed(c.returnPct)}%</td><td>${c.holdDays ?? '–'} ngày</td></tr>`).join('')}
    </tbody></table></div>` : ''}</section>` : '';

  // Sổ tiền mặt: nạp / rút / cổ tức và tiền mua / bán, số dư sau mỗi dòng; dòng tiền nhập tay xóa được
  const cap = p.capital || {};
  $('pf-cash-sub').innerHTML = cap.cash != null
    ? `Tiền mặt hiện có <b>${vnd(cap.cash)}</b>${cap.available != null && cap.available !== cap.cash ? ` (rút được ${vnd(cap.available)}, chờ về ${vnd(cap.pendingSale)})` : ''} · vốn thực nạp ròng <b>${vnd(cap.netContributed)}</b>`
    : 'Chưa có dòng tiền nào: ghi khoản nạp đầu tiên để tool tính đúng tiền mặt và vốn thực nạp ròng.';
  const cashRows = (p.cashHistory || []).map((c) => `<tr>
      <td>${c.date.split('-').reverse().join('/')}</td>
      <td style="font-family:inherit">${esc(c.label)}</td>
      <td class="${dirClass(c.delta)}">${c.delta >= 0 ? '+' : ''}${vnd(c.delta)}</td>
      <td>${vnd(c.balance)}</td>
      <td class="muted small" style="font-family:inherit">${esc(c.note)}</td>
      <td>${c.kind === 'cash' ? `<button type="button" class="btn btn-glass btn-xs" data-del-cash="${esc(c.id)}" title="Xóa dòng tiền">✕</button>` : ''}</td></tr>`).join('');
  const cashCard = cashRows ? `<section class="card"><div class="card-head"><div><h3>📒 Sổ tiền mặt</h3><div class="muted small">Mới nhất trước. Dòng mua / bán xóa ở Nhật ký lệnh.</div></div><span class="badge-subtle">${p.cashHistory.length} dòng</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>Loại</th><th>Số tiền</th><th>Số dư sau</th><th>Ghi chú</th><th></th></tr></thead><tbody>${cashRows}</tbody></table></div></section>` : '';

  $('pf-sub').textContent = `${s.positions} mã đang nắm giữ · cập nhật ${new Date(p.updatedAt).toLocaleTimeString('vi-VN')}`;
  $('pf-body').innerHTML = `
    <section class="card"><div class="ai-levels" style="margin:0">
      ${kpi('Giá trị thị trường', fmtBig(s.marketValue))}
      ${kpi('Giá vốn', fmtBig(s.cost))}
      ${kpi('Lãi/lỗ tạm tính', `${fmtBig(s.unrealized)} (${signed(s.unrealizedPct)}%)`, dirClass(s.unrealized))}
      ${kpi('Biến động hôm nay', fmtBig(s.dayChange), dirClass(s.dayChange))}
      ${kpi('Lãi đã chốt', fmtBig(s.realized), dirClass(s.realized))}
    </div></section>
    ${renderCapitalOverview(p)}
    ${renderPortfolioHeat(p)}
    <section class="card"><div class="card-head"><h3>📊 Vị thế đang nắm giữ</h3></div>${holdings}</section>
    ${p.holdings.length ? '<section class="card" id="pf-advice"><div class="card-head"><div><h3>🔎 Phân tích rủi ro mã đang nắm</h3><div class="muted small">Đang phân tích từng mã…</div></div></div></section>' : ''}
    ${riskCard}${behaviorCard}${txs}${cashCard}`;
}

/** "5tr", "1,5 triệu", "500k", "2 tỷ", "5.000.000" → số đồng; null nếu không đọc được. */
function parseMoney(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  const m = /^([\d.,]+)(tr|triệu|trieu|m|k|nghìn|nghin|ngàn|ngan|tỷ|ty|b)?đ?$/.exec(t);
  if (!m) return null;
  const unit = { tr: 1e6, 'triệu': 1e6, trieu: 1e6, m: 1e6, k: 1e3, 'nghìn': 1e3, nghin: 1e3, 'ngàn': 1e3, ngan: 1e3, 'tỷ': 1e9, ty: 1e9, b: 1e9 }[m[2]] || 1;
  // Có đơn vị: dấu , hoặc . là phần thập phân ("1,5tr"); không đơn vị: dấu . , là phân cách hàng nghìn ("5.000.000")
  const n = unit > 1 ? Number(m[1].replace(',', '.')) : Number(m[1].replace(/[.,]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * unit) : null;
}

$('pf-cash-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const amount = parseMoney(f.amount.value);
  if (amount == null || (amount <= 0 && f.type.value !== 'SET')) { showToast('Số tiền không hợp lệ: nhập như 5tr, 500k hoặc 5.000.000', 'error', 5000); return; }
  const label = f.type.selectedOptions[0].textContent;
  if (!confirm(`${label} ${vnd(amount)} ngày ${f.date.value.split('-').reverse().join('/')}?`)) return;
  try {
    await api('/api/portfolio/cash', { method: 'POST', body: JSON.stringify({ type: f.type.value, amount, date: f.date.value, note: f.note.value }) });
    showToast(`Đã ghi: ${label} ${vnd(amount)}`, 'success');
    f.amount.value = '';
    f.note.value = '';
    loadPortfolio();
  } catch (err) {
    showToast(err.message, 'error', 6000);
  }
});

$('pf-btn')?.addEventListener('click', showPortfolio);
$('pf-refresh')?.addEventListener('click', loadPortfolio);
$('pf-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.symbol = body.symbol.trim().toUpperCase();
  try {
    await api('/api/portfolio/tx', { method: 'POST', body: JSON.stringify(body) });
    showToast(`Đã ghi lệnh ${body.type === 'BUY' ? 'mua' : 'bán'} ${body.qty} ${body.symbol}`, 'success');
    e.target.qty.value = '';
    e.target.price.value = '';
    e.target.note.value = '';
    loadPortfolio();
  } catch (err) {
    showToast(err.message, 'error', 5000);
  }
});
$('pf-body')?.addEventListener('click', async (e) => {
  const sym = e.target.closest('.pf-sym');
  if (sym) {
    e.preventDefault();
    analyze(sym.dataset.sym);
    return;
  }
  const delCash = e.target.closest('[data-del-cash]');
  if (delCash) {
    if (!confirm('Xóa dòng tiền này khỏi sổ tiền mặt?')) return;
    try {
      await api(`/api/portfolio/cash/${encodeURIComponent(delCash.dataset.delCash)}`, { method: 'DELETE' });
      loadPortfolio();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del && confirm('Xóa lệnh này khỏi nhật ký?')) {
    try {
      await api(`/api/portfolio/tx/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      loadPortfolio();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});


// ---------- Kiểm tra các API key AI ----------
$('btn-ai-check')?.addEventListener('click', async () => {
  showToast('Đang gửi yêu cầu thử tới từng nhà cung cấp AI…', 'info', 2500);
  try {
    const list = await api('/api/ai/test', { method: 'POST' });
    if (!list.length) return showToast('Chưa có API key AI nào trong file .env', 'error', 6000);
    list.forEach((r, i) => setTimeout(() => showToast(r.ok
      ? `✓ ${r.provider}: hoạt động (${r.model}, ${(r.ms / 1000).toFixed(1)}s)`
      : `${r.provider}: ${r.error}`, r.ok ? 'success' : 'error', 9000), i * 300));
    state.ai = await api('/api/ai/status').catch(() => state.ai);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Xếp hạng 4 yếu tố ----------
const RK = { chart: null, result: null };
const RANK_TONE = { STRONG: 'up', WAIT: 'ref', GOOD: 'up', AVERAGE: 'ref', WEAK: 'down', NA: 'ref' };
const FACTOR_LABELS = { mom: 'Động lượng 12T', high: 'Gần đỉnh 52 tuần', atr: 'Biến động thấp', adx: 'Xu hướng (ADX)' };

function rankBar(v) {
  return `<div class="rk-bar"><i style="width:${Math.max(2, v)}%" class="${v >= 60 ? 'pos' : v < 40 ? 'neg' : ''}"></i></div>`;
}

function renderRankCard(a) {
  const el = $('rank-card');
  const r = a.ranking;
  el.hidden = a.isIndex || !r;
  if (el.hidden) return;
  const f = r.factors;
  const raw = { mom: pct(f.mom), high: pct(f.high), atr: f.atr != null ? `${fmt(f.atr * 100, 1)}%/phiên` : '–', adx: fmt(f.adx, 0) };
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:10px">
      <div>
        <h3>🎯 Điểm xếp hạng 4 yếu tố <span class="badge-subtle">đã kiểm chứng ngoài mẫu</span></h3>
        <div class="muted small">Hạng ${r.position}/${r.universe} trong rổ HOSE ≥ 5 tỷ/phiên · ${r.aboveMa200 === false ? '<span class="down">giá dưới MA200</span>' : '<span class="up">giá trên MA200</span>'}</div>
        <div class="small" style="margin-top:4px">${r.pfRank == null ? '<span class="down">Ngoài nhóm mua/giữ (dưới MA200)</span>'
          : r.pfRank <= 8 ? `<span class="up">▲ Thuộc danh mục mẫu: hạng ${r.pfRank} trong nhóm trên MA200 (top 8)</span>`
          : `<span class="ref">Hạng ${r.pfRank} trong nhóm trên MA200 (ngoài danh mục mẫu top 8)</span>`}</div>
      </div>
      <div class="rk-score ${RANK_TONE[r.code]}"><b>${r.score}</b><span>/100</span><div>${esc(r.label)}</div></div>
    </div>
    <div class="rk-factors">
      ${Object.keys(FACTOR_LABELS).filter((k) => r.parts[k] != null).map((k) => `
        <div class="rk-factor"><div class="k">${FACTOR_LABELS[k]} <span class="muted">${raw[k]}</span></div>${rankBar(r.parts[k])}<div class="v">${r.parts[k]}</div></div>`).join('')}
    </div>
    <p class="muted small" style="margin:10px 0 0">Điểm ≥ 70 và trên MA200 = nhóm dẫn đầu (tín hiệu mua). Điểm &lt; 30 = nhóm đội sổ (nên tránh). Điểm này dùng để <b>so sánh, chọn mã mạnh hơn thị trường</b>, nên đọc cùng khung 20 phiên trở lên.
      <a href="#xep-hang" id="rk-open-view">Xem bảng xếp hạng →</a></p>`;
}
$('rank-card')?.addEventListener('click', (e) => {
  if (e.target.id === 'rk-open-view') { e.preventDefault(); showRankView(); }
});

function showRankView() {
  ['marketview', 'empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'sectorview', 'autoview'].forEach((id) => ($(id).hidden = true));
  $('auto-btn')?.classList.remove('on');
  markMobileView('analyze', 'more');
  $('sector-btn')?.classList.remove('on');
  $('picks-btn')?.classList.remove('on');
  $('pf-btn')?.classList.remove('on');
  $('rankview').hidden = false;
  $('rank-btn')?.classList.add('on');
  history.replaceState(null, '', '#xep-hang');
  loadRankBoard();
  setTimeout(loadPredictions, 100);
  if (RK.result) renderRankBacktest(RK.result);
}

let currentRankBoard = null;
let currentRankFilter = 'all';

function renderRankTable(b, filter = 'all') {
  currentRankFilter = filter;
  const trendCount = (b.rows || []).filter((r) => r.trendPick).length;
  const riskCount = (b.rows || []).filter((r) => r.trend?.trendState === 'DOWN' && (r.factors?.high <= -0.30 || r.score < 30)).length;
  
  let displayed = b.rows;
  if (filter === 'top8') displayed = b.rows.filter((r) => r.pfRank != null && r.pfRank <= 8);
  else if (filter === 'tp') displayed = b.rows.filter((r) => r.trendPick);
  else if (filter === 'risk') displayed = b.rows.filter((r) => r.trend?.trendState === 'DOWN' && (r.factors?.high <= -0.30 || r.score < 30));

  const chips = [
    `<button type="button" class="btn btn-glass btn-xs ${filter === 'all' ? 'on' : ''}" data-rk-flt="all">Tất cả (${b.rows.length})</button>`,
    `<button type="button" class="btn btn-glass btn-xs ${filter === 'top8' ? 'on' : ''}" data-rk-flt="top8">Top 8 danh mục mẫu</button>`,
    `<button type="button" class="btn btn-glass btn-xs ${filter === 'tp' ? 'on' : ''}" data-rk-flt="tp" style="color:var(--c-primary);font-weight:700">★ Trend Picks (${trendCount})</button>`,
    `<button type="button" class="btn btn-glass btn-xs ${filter === 'risk' ? 'on' : ''}" data-rk-flt="risk" style="color:#f6465d;font-weight:700">🚨 Rủi ro sụt giảm (${riskCount})</button>`,
  ].join(' ');

  $('rk-board').innerHTML = `
    <div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">${chips}</div>
    <div class="tbl-wrap"><table class="tbl rk-table"><thead><tr><th>#</th><th>Mã</th><th>Giá</th><th>Hôm nay</th><th>GTGD TB20</th><th>Điểm</th><th>Đánh giá</th>
    ${Object.values(FACTOR_LABELS).map((l) => `<th>${l}</th>`).join('')}<th>MA200</th></tr></thead><tbody>
    ${displayed.map((r, i) => `<tr class="${r.pfRank != null && r.pfRank <= 8 ? 'rk-top' : ''}">
      <td>${i + 1}</td><td><a href="#${r.symbol}" class="pf-sym" data-sym="${r.symbol}"><b>${r.symbol}</b></a>${r.trendPick ? ' <span class="st-badge up" style="font-size:10px;margin-left:4px" title="Trend Pick 8 năm">★ TP</span>' : ''}</td>
      <td>${fmt(r.close)}</td><td class="${dirClass(r.changePct)}">${signed(r.changePct)}%</td><td>${fmt(r.value20 / 1e9, 1)} tỷ</td>
      <td><b class="${RANK_TONE[r.code]}">${r.score}</b></td><td class="${RANK_TONE[r.code]}" style="font-family:inherit">${esc(r.label)}</td>
      <td>${pct(r.factors.mom)}</td><td>${pct(r.factors.high)}</td><td>${r.factors.atr != null ? `${fmt(r.factors.atr * 100, 1)}%` : '–'}</td><td>${fmt(r.factors.adx, 0)}</td>
      <td>${r.aboveMa200 === false ? '<span class="down">dưới</span>' : '<span class="up">trên</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small" style="margin-top:6px">Hàng tô sáng = top 8 trên MA200 (danh mục mẫu tự động). Bấm mã để phân tích chi tiết.</p>`;
}

async function loadRankBoard() {
  if (!currentRankBoard) {
    try {
      const cached = sessionStorage.getItem('last_rank_board');
      if (cached) {
        currentRankBoard = JSON.parse(cached);
        $('rk-sub').textContent = `Phiên ${currentRankBoard.date} · ${currentRankBoard.universe} mã sàn ${currentRankBoard.criteria.floors.join(', ')} có giá trị giao dịch TB 20 phiên ≥ ${fmt(currentRankBoard.criteria.minValue / 1e9, 1)} tỷ · cập nhật ${new Date(currentRankBoard.updatedAt).toLocaleTimeString('vi-VN')}`;
        renderRankTable(currentRankBoard, currentRankFilter);
        renderSidebarScan(currentRankBoard);
      }
    } catch {}
    if (!currentRankBoard) {
      $('rk-board').innerHTML = '<p class="muted">Đang tải bảng xếp hạng…</p>';
    }
  }
  try {
    const b = await api('/api/rank');
    currentRankBoard = b;
    try { sessionStorage.setItem('last_rank_board', JSON.stringify(b)); } catch {}
    $('rk-sub').textContent = `Phiên ${b.date} · ${b.universe} mã sàn ${b.criteria.floors.join(', ')} có giá trị giao dịch TB 20 phiên ≥ ${fmt(b.criteria.minValue / 1e9, 1)} tỷ · cập nhật ${new Date(b.updatedAt).toLocaleTimeString('vi-VN')}`;
    renderRankTable(b, currentRankFilter);
    renderSidebarScan(b);
  } catch (err) {
    if (!currentRankBoard) $('rk-board').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('rk-board')?.addEventListener('click', (e) => {
  const flt = e.target.closest('[data-rk-flt]');
  if (flt && currentRankBoard) {
    renderRankTable(currentRankBoard, flt.dataset.rkFlt);
    return;
  }
  const s = e.target.closest('.pf-sym');
  if (s) { e.preventDefault(); analyze(s.dataset.sym); }
});

// ==========================================================================
// SIDEBAR SCAN & HOVER TOOLTIP (THEO PHONG CÁCH LABAN - IMAGES 1 & 2)
// ==========================================================================
let stockNamesMap = {};
let scanCurrentFilter = 'TOP10';
let scanCurrentSort = 'val_desc';
let scanSearchQuery = '';

async function loadStockNames() {
  try {
    stockNamesMap = await api('/api/stock-names');
  } catch (e) {
    console.warn('loadStockNames:', e);
  }
}

function formatPriceSmart(p) {
  if (p == null || !Number.isFinite(p)) return '--';
  const vnd = p < 1000 ? Math.round(p * 1000) : Math.round(p);
  return vnd.toLocaleString('vi-VN');
}

function formatValSmart(v) {
  if (v == null || !Number.isFinite(v)) return '--';
  const bil = v >= 1e9 ? v / 1e9 : v / 1e6;
  const unit = v >= 1e9 ? 'tỷ' : 'tr';
  const formatted = (bil >= 100 || (bil >= 10 && Math.abs(bil - Math.round(bil)) < 0.1))
    ? Math.round(bil).toString()
    : bil.toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${formatted} ${unit}`;
}

function buildStockTooltipText(r) {
  const meta = stockNamesMap[r.symbol] || {};
  const fullName = r.companyName || meta.name || r.shortName || meta.short_name || r.symbol;
  const sector = (r.sector || meta.sector) ? ` • ${r.sector || meta.sector}` : '';
  const exchange = r.exchange || meta.floor || 'HOSE';
  const header = `${r.symbol} (${exchange}): ${fullName}${sector}`;

  // 1. Phân tích Xu hướng Kỹ thuật theo Vn-Stock-Advisor
  let trendIcon = '➡️';
  let trendDesc = 'Đi ngang / Tích lũy quanh MA50';
  if (r.trend?.trendState === 'UP') {
    trendIcon = '📈';
    trendDesc = 'Xu hướng tăng mạnh (Giá > MA50 > MA200)';
  } else if (r.trend?.trendState === 'DOWN') {
    trendIcon = '📉';
    trendDesc = 'Xu hướng giảm (Giá < MA50 < MA200)';
  }
  const pct52 = r.trend?.pctFrom52wHigh != null
    ? ` • Cách đỉnh 52 tuần: ${(r.trend.pctFrom52wHigh >= 0 ? '+' : '')}${r.trend.pctFrom52wHigh.toFixed(1).replace('.', ',')}%`
    : '';
  const ma200Tag = r.aboveMa200 === false ? ' • ⚠️ Dưới MA200' : (r.aboveMa200 === true ? ' • Đạt chuẩn trên MA200' : '');
  let trendText = `${trendIcon} ${trendDesc}${pct52}${ma200Tag}`;
  if (r.trendPick) {
    trendText += '\n🧭 VỊ THẾ DẪN SÓNG: Cổ phiếu tiệm cận đỉnh 52 tuần, nền giá biến động thấp và hút dòng tiền.';
  }

  // 2. Điểm Định lượng Đa nhân tố & Khuyến nghị của Vn-Stock-Advisor
  const momPct = r.parts?.mom != null ? Math.round(r.parts.mom * 100) : null;
  const highPct = r.parts?.high != null ? Math.round(r.parts.high * 100) : null;
  const atrPct = r.parts?.atr != null ? Math.round(r.parts.atr * 100) : null;
  const adxPct = r.parts?.adx != null ? Math.round(r.parts.adx * 100) : null;
  const pillars = (momPct != null && highPct != null)
    ? `\n📊 4 Trụ cột định lượng: Động lượng ${momPct}/100 | Vị thế đỉnh ${highPct}/100 | Ổn định ATR ${atrPct}/100 | Xung lực ADX ${adxPct}/100`
    : '';

  let rankText = '';
  if (r.avoid || (r.score != null && r.score <= 20)) {
    rankText = `⛔ Tín hiệu: NÊN TRÁNH (Điểm hệ thống: ${r.score ?? '--'}/100).\nThuộc nhóm suy yếu về dòng tiền và hiệu suất giá. Rủi ro sụt giảm cao, tuyệt đối không bắt đáy.${pillars}`;
  } else if (r.score >= 70 && r.aboveMa200 !== false) {
    rankText = `🟢 Tín hiệu: NÊN MUA (Điểm hệ thống: ${r.score}/100 - Nhóm dẫn đầu).\nĐạt tiêu chí toàn diện về động lượng, xu hướng và dòng tiền trên MA200.${pillars}`;
  } else if (r.score >= 70 && r.aboveMa200 === false) {
    rankText = `🟡 Tín hiệu: THEO DÕI (Điểm hệ thống: ${r.score}/100).\nĐiểm số cao nhưng giá đang dưới MA200: Rào chắn kỷ luật yêu cầu chờ giá vượt cản MA200 xác nhận.${pillars}`;
  } else if (r.score != null) {
    rankText = `⚪ Tín hiệu: THEO DÕI (Điểm hệ thống: ${r.score}/100).\nTrạng thái trung tính, chưa đủ lợi thế xác nhận để giải ngân mới.${pillars}`;
  }

  // 3. Rào chắn Quản trị Rủi ro & Kỷ luật của Vn-Stock-Advisor
  let warnText = '';
  let isGuideline = false;
  if (r.buyWarnings?.length) {
    warnText = r.buyWarnings.map((w) => `⚠️ CẢNH BÁO KHOAN MUA [${w.name}]: ${w.text}`).join('\n');
  } else if (r.isRisky && r.reasons?.length) {
    warnText = `⚠️ CẢNH BÁO RỦI RO CAO: ${r.reasons.join(' | ')}. Giảm sàn hoặc xả mạnh, không tham gia.`;
  } else if (r.aboveMa200 === false && (r.score == null || r.score < 70)) {
    warnText = '⚠️ CẢNH BÁO DƯỚI MA200: Cổ phiếu chưa vượt được đường trung bình 200 ngày, chỉ theo dõi.';
  } else if (r.score >= 70 && r.aboveMa200 !== false) {
    warnText = '🎯 Kỷ luật quản trị vốn: Giải ngân 1 suất (≤ 10-15% NAV), cắt lỗ cứng khi vi phạm hỗ trợ, tuân thủ chu kỳ T+2.';
    isGuideline = true;
  }

  const actionHint = '👉 Bấm để nạp biểu đồ & Hội đồng Đầu tư AI phản biện';
  const fullRaw = [header, trendText, rankText, warnText, actionHint].filter(Boolean).join('\n');

  return { header, trendText, rankText, warnText, isGuideline, actionHint, fullRaw };
}

function showStockTooltip(e, r) {
  const tooltip = $('stock-hover-tooltip');
  if (!tooltip || !r) return;

  const data = buildStockTooltipText(r);
  $('tt-header').textContent = data.header;
  $('tt-trend').textContent = data.trendText;
  $('tt-rank').textContent = data.rankText;

  const warnEl = $('tt-warning');
  if (data.warnText) {
    warnEl.textContent = data.warnText;
    warnEl.hidden = false;
    warnEl.className = data.isGuideline ? 'tooltip-warning tooltip-guideline' : 'tooltip-warning';
  } else {
    warnEl.hidden = true;
  }

  positionTooltip(e);
  tooltip.hidden = false;
  tooltip.classList.add('visible');
}

function positionTooltip(e) {
  const tooltip = $('stock-hover-tooltip');
  if (!tooltip || tooltip.hidden) return;

  const offset = 14;
  let x = e.clientX + offset;
  let y = e.clientY + offset;

  const rect = tooltip.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  if (x + rect.width > winW - 12) {
    x = e.clientX - rect.width - offset;
  }
  if (y + rect.height > winH - 12) {
    y = e.clientY - rect.height - offset;
  }
  x = Math.max(10, x);
  y = Math.max(10, y);

  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideStockTooltip() {
  const tooltip = $('stock-hover-tooltip');
  if (tooltip) {
    tooltip.classList.remove('visible');
    tooltip.hidden = true;
  }
}

function renderSidebarScan(board) {
  if (!board || !board.rows) return;
  const tbody = $('scan-results-body');
  if (!tbody) return;

  const rowsAll = board.rows;

  // Cập nhật số lượng trên các nút pill
  const cAll = rowsAll.length;
  const cTrend = rowsAll.filter((r) => r.trendPick).length;
  const cTop10 = rowsAll.filter((r) => (r.score >= 70 && r.aboveMa200 !== false) || (r.pfRank != null && r.pfRank <= 17)).length;
  const cRisk = rowsAll.filter((r) => r.avoid || (r.score != null && r.score <= 20) || r.trend?.trendState === 'DOWN').length;

  if ($('count-all')) $('count-all').textContent = cAll;
  if ($('count-trend')) $('count-trend').textContent = cTrend;
  if ($('count-top10')) $('count-top10').textContent = cTop10;
  if ($('count-risk')) $('count-risk').textContent = cRisk;

  // Lọc theo từ khóa tìm kiếm
  let filtered = rowsAll;
  if (scanSearchQuery) {
    const q = scanSearchQuery.toUpperCase();
    filtered = filtered.filter((r) => {
      const sym = r.symbol.toUpperCase();
      const meta = stockNamesMap[sym] || {};
      const name = (r.companyName || meta.name || '').toUpperCase();
      const short = (r.shortName || meta.short_name || '').toUpperCase();
      return sym.includes(q) || name.includes(q) || short.includes(q);
    });
  }

  // Lọc theo pill
  if (scanCurrentFilter === 'TREND') {
    filtered = filtered.filter((r) => r.trendPick);
  } else if (scanCurrentFilter === 'TOP10') {
    filtered = filtered.filter((r) => (r.score >= 70 && r.aboveMa200 !== false) || (r.pfRank != null && r.pfRank <= 17));
  } else if (scanCurrentFilter === 'RISK') {
    filtered = filtered.filter((r) => r.avoid || (r.score != null && r.score <= 20) || r.trend?.trendState === 'DOWN');
  }

  // Sắp xếp
  filtered = [...filtered].sort((a, b) => {
    switch (scanCurrentSort) {
      case 'val_desc': return (b.value20 || 0) - (a.value20 || 0);
      case 'val_asc': return (a.value20 || 0) - (b.value20 || 0);
      case 'price_desc': return (b.close || 0) - (a.close || 0);
      case 'price_asc': return (a.close || 0) - (b.close || 0);
      case 'rank_desc': return (b.score || 0) - (a.score || 0);
      case 'rank_asc': return (a.score || 0) - (b.score || 0);
      case 'change_desc': return (b.changePct || 0) - (a.changePct || 0);
      case 'change_asc': return (a.changePct || 0) - (b.changePct || 0);
      case 'ticker_asc': return a.symbol.localeCompare(b.symbol);
      case 'ticker_desc': return b.symbol.localeCompare(a.symbol);
      default: return (b.value20 || 0) - (a.value20 || 0);
    }
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px 8px;color:var(--muted)">Không có cổ phiếu nào phù hợp bộ lọc</td></tr>`;
    return;
  }

  const currentSym = state.current?.symbol;
  tbody.innerHTML = filtered.map((r) => {
    const isTop = (r.score >= 70 && r.aboveMa200 !== false) || (r.pfRank != null && r.pfRank <= 17);
    const isAvoid = r.avoid || (r.score != null && r.score <= 20);
    const symCls = isTop ? ' top' : (isAvoid ? ' avoid' : '');

    // Cột xu hướng
    let trendIcon = '→';
    let trendCls = '';
    if (r.trend?.trendState === 'UP') { trendIcon = '↗'; trendCls = ' up'; }
    else if (r.trend?.trendState === 'DOWN') { trendIcon = '↘'; trendCls = ' down'; }
    const tpBadge = r.trendPick ? '<span title="Cổ phiếu dẫn sóng">🧭 </span>' : '';
    const distText = r.trend?.pctFrom52wHigh != null ? `${r.trend.pctFrom52wHigh >= 0 ? '+' : ''}${Math.round(r.trend.pctFrom52wHigh)}%` : '';

    // Cột điểm
    let rankHtml = `<span class="scan-score-badge">${r.score ?? '--'}</span>`;
    if (isTop) rankHtml = `<span class="scan-score-badge top">${r.score}</span>`;
    else if (isAvoid) rankHtml = `<span class="scan-score-badge avoid">⛔${r.score}</span>`;

    const tipData = buildStockTooltipText(r);
    const activeCls = (r.symbol === currentSym) ? ' is-active-sym' : '';
    const topCls = isTop ? ' is-top10' : '';

    return `<tr data-sym="${r.symbol}" class="${topCls}${activeCls}">
      <td><span class="scan-sym${symCls}">${r.symbol}</span></td>
      <td><span class="scan-trend${trendCls}">${tpBadge}${trendIcon}</span> <span class="scan-dist">${distText}</span></td>
      <td>${rankHtml}</td>
      <td>${formatPriceSmart(r.close)}</td>
      <td>${formatValSmart(r.value20)}</td>
    </tr>`;
  }).join('');

  updateTableSortIndicators();
}

function updateTableSortIndicators() {
  const headers = document.querySelectorAll('#scan-results-table th.th-sortable');
  headers.forEach((th) => {
    const key = th.dataset.key;
    const arrow = th.querySelector('.sort-arr');
    if (!arrow) return;
    if (key === 'val' && scanCurrentSort === 'val_desc') arrow.textContent = '▼';
    else if (key === 'val' && scanCurrentSort === 'val_asc') arrow.textContent = '▲';
    else if (key === 'price' && scanCurrentSort === 'price_desc') arrow.textContent = '▼';
    else if (key === 'price' && scanCurrentSort === 'price_asc') arrow.textContent = '▲';
    else if (key === 'rank' && scanCurrentSort === 'rank_desc') arrow.textContent = '▼';
    else if (key === 'rank' && scanCurrentSort === 'rank_asc') arrow.textContent = '▲';
    else if (key === 'ticker' && scanCurrentSort === 'ticker_asc') arrow.textContent = '▲';
    else if (key === 'ticker' && scanCurrentSort === 'ticker_desc') arrow.textContent = '▼';
    else arrow.textContent = '⇕';
  });
}

function setupSidebarScanEvents() {
  // Chuyển đổi chế độ sidebar (Quét & Xếp hạng / Danh mục / Thị trường)
  const modeTabs = document.querySelectorAll('.side-mode-btn');
  modeTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      modeTabs.forEach((b) => {
        b.classList.remove('on');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('on');
      btn.setAttribute('aria-selected', 'true');

      const side = btn.dataset.side;
      if ($('side-scan-panel')) $('side-scan-panel').hidden = side !== 'scan';
      if ($('side-wl-panel')) $('side-wl-panel').hidden = side !== 'wl';
      const moversEl = $('movers');
      if (moversEl) moversEl.hidden = side !== 'movers';
    });
  });

  // Filter pills
  const pills = document.querySelectorAll('.btn-scan-pill');
  pills.forEach((p) => {
    p.addEventListener('click', () => {
      pills.forEach((x) => x.classList.remove('on'));
      p.classList.add('on');
      scanCurrentFilter = p.dataset.flt;
      if (currentRankBoard) renderSidebarScan(currentRankBoard);
    });
  });

  // Sort select
  $('scan-sort-select')?.addEventListener('change', (e) => {
    scanCurrentSort = e.target.value;
    if (currentRankBoard) renderSidebarScan(currentRankBoard);
  });

  // Tìm kiếm
  const searchInput = $('scan-search-input');
  const clearBtn = $('btn-clear-scan-search');
  searchInput?.addEventListener('input', (e) => {
    scanSearchQuery = e.target.value.trim();
    if (clearBtn) clearBtn.hidden = !scanSearchQuery;
    if (currentRankBoard) renderSidebarScan(currentRankBoard);
  });
  clearBtn?.addEventListener('click', () => {
    searchInput.value = '';
    scanSearchQuery = '';
    clearBtn.hidden = true;
    if (currentRankBoard) renderSidebarScan(currentRankBoard);
    searchInput.focus();
  });

  // Click vào tiêu đề cột để đảo chiều sắp xếp
  const headers = document.querySelectorAll('#scan-results-table th.th-sortable');
  headers.forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (key === 'val') {
        scanCurrentSort = scanCurrentSort === 'val_desc' ? 'val_asc' : 'val_desc';
      } else if (key === 'price') {
        scanCurrentSort = scanCurrentSort === 'price_desc' ? 'price_asc' : 'price_desc';
      } else if (key === 'rank') {
        scanCurrentSort = scanCurrentSort === 'rank_desc' ? 'rank_asc' : 'rank_desc';
      } else if (key === 'ticker') {
        scanCurrentSort = scanCurrentSort === 'ticker_asc' ? 'ticker_desc' : 'ticker_asc';
      }
      if ($('scan-sort-select')) $('scan-sort-select').value = scanCurrentSort;
      if (currentRankBoard) renderSidebarScan(currentRankBoard);
    });
  });

  // Click hàng & Hover tooltip qua event delegation (Flicker-free tracking)
  const tbody = $('scan-results-body');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sym]');
      if (tr && tr.dataset.sym) {
        hideStockTooltip();
        analyze(tr.dataset.sym);
      }
    });

    let currentHoverSym = null;
    tbody.addEventListener('mousemove', (e) => {
      const tr = e.target.closest('tr[data-sym]');
      if (!tr) {
        if (currentHoverSym) {
          currentHoverSym = null;
          hideStockTooltip();
        }
        return;
      }
      const sym = tr.dataset.sym;
      if (sym !== currentHoverSym) {
        currentHoverSym = sym;
        const rowData = currentRankBoard?.rows?.find((x) => x.symbol === sym);
        if (rowData) showStockTooltip(e, rowData);
        else hideStockTooltip();
      } else {
        positionTooltip(e);
      }
    });

    tbody.addEventListener('mouseleave', () => {
      currentHoverSym = null;
      hideStockTooltip();
    });
  }

  // Toàn bộ các phần tử có [data-sym] trên giao diện cũng có tooltip thông minh
  let globalHoverSym = null;
  document.addEventListener('mousemove', (e) => {
    if (e.target.closest('#scan-results-body')) return; // tbody đã tự xử lý
    const el = e.target.closest('[data-sym]');
    if (!el) {
      if (globalHoverSym) {
        globalHoverSym = null;
        hideStockTooltip();
      }
      return;
    }
    const sym = el.dataset.sym;
    if (sym !== globalHoverSym) {
      globalHoverSym = sym;
      const rowData = currentRankBoard?.rows?.find((x) => x.symbol === sym) || { symbol: sym };
      showStockTooltip(e, rowData);
    } else {
      positionTooltip(e);
    }
  });
}

$('rk-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new URLSearchParams(new FormData(e.target));
  $('rk-run').disabled = true;
  $('rk-bt').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
    <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div><span>Đang mô phỏng danh mục…</span></div>`;
  try {
    RK.result = await api(`/api/rank/backtest?${q}`);
    renderRankBacktest(RK.result);
  } catch (err) {
    $('rk-bt').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $('rk-run').disabled = false;
  }
});

function renderRankBacktest(r) {
  const m = r.metrics, ac = r.accuracy;
  const kpi = (k, v, cls = '') => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const beat = m.totalReturn > (m.benchmarkReturn ?? 0);
  $('rk-bt').innerHTML = `
    <div class="bt-verdict tone-${beat ? 'up' : 'down'}">Danh mục top ${r.config.top} ${beat ? 'thắng' : 'thua'} VN-Index: ${pct(m.totalReturn)} so với ${pct(m.benchmarkReturn)}
      (rổ chia đều ${pct(r.equalWeight.totalReturn)}). Thắng chỉ số ${ac.periodsBeatIndex}/${ac.periods} kỳ, ${fmt((ac.picksBeatIndex / ac.picks) * 100, 0)}% số mã được chọn thắng chỉ số.</div>
    <div class="muted small" style="margin:6px 0 12px">${r.period.from} → ${r.period.to} · ${r.config.universe} mã${r.universe ? (r.universe.survivorshipBias ? ' <span class="down">(rổ hiện tại: có thiên lệch sống sót, kết quả bị thổi phồng)</span>' : ` (rổ theo thời điểm${r.universe.missingPrice ? `, ${r.universe.missingPrice} mã thiếu dữ liệu giá` : ''}${r.universe.delistedExits ? `, ${r.universe.delistedExits} lần thoát do hủy niêm yết` : ''})`) : ''} · tái cơ cấu mỗi ${r.config.rebalance} phiên · giữ mã còn trong top ${r.config.top * (r.config.buffer ?? 1)} · ${r.config.earnings ? 'có yếu tố KQKD quý · ' : ''}${r.config.trendFilter ? 'có' : 'không'} lọc MA200 · khi VN-Index yếu: ${{ none: 'vẫn đầy vốn', half: 'giữ nửa số mã', cash: 'cầm tiền' }[r.config.regime]} (${r.regime.bearPeriods}/${r.regime.periods} kỳ thị trường yếu, hiện tại ${r.regime.now === 'bear' ? '<span class="down">yếu</span>' : '<span class="up">tốt</span>'}) · vốn ${fmtBig(r.config.initialCash)}</div>
    <div class="ai-levels bt-kpis">
      ${kpi('Lợi nhuận', pct(m.totalReturn), dirClass(m.totalReturn))}
      ${kpi('Mỗi năm', pct(m.annualReturn), dirClass(m.annualReturn))}
      ${kpi('VN-Index', pct(m.benchmarkReturn), dirClass(m.benchmarkReturn))}
      ${kpi('Rổ chia đều', pct(r.equalWeight.totalReturn), dirClass(r.equalWeight.totalReturn))}
      ${kpi('Sụt giảm tối đa', pct(m.maxDrawdown), 'down')}
      ${kpi('Sharpe', fmt(m.sharpe))}
      ${kpi('Kỳ thắng VN-Index', `${ac.periodsBeatIndex}/${ac.periods} (${fmt((ac.periodsBeatIndex / ac.periods) * 100, 0)}%)`, 'up')}
      ${kpi('Vượt VN-Index TB/kỳ', pct(ac.avgExcess, 2), dirClass(ac.avgExcess))}
      ${kpi('Lệnh / tỷ lệ thắng', `${m.tradeCount} / ${fmt(m.winRate * 100, 0)}%`)}
      ${kpi('Phí + thuế', fmtBig(r.fees))}
    </div>
    <div class="legend"><span style="color:var(--accent)">━ Danh mục top ${r.config.top}</span> · <span style="color:var(--s2)">━ Rổ chia đều</span> · <span style="color:var(--muted)">━ VN-Index</span></div>
    <div id="rk-chart" class="bt-chart"></div>
    <div class="bt-grid">
      <div class="bt-block"><h4>Các kỳ gần nhất</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kỳ</th><th>Danh mục</th><th>VN-Index</th><th>Chênh</th></tr></thead><tbody>
        ${r.periods.slice(0, 12).map((p) => `<tr title="${p.picks.map((x) => `${x.symbol} ${pct(x.ret)}`).join(', ')}"><td>${p.from}${p.open ? ' (đang chạy)' : ''}</td>
          <td class="${dirClass(p.ret)}">${pct(p.ret)}</td><td class="${dirClass(p.indexReturn)}">${pct(p.indexReturn)}</td><td class="${dirClass(p.excess)}">${pct(p.excess)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="bt-block"><h4>Danh mục đang nắm giữ (theo mô phỏng)</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mã</th><th>Từ ngày</th><th>Giá mua</th><th>Lãi/lỗ</th></tr></thead><tbody>
        ${r.holdings.map((h) => `<tr><td>${h.symbol}</td><td>${h.since}</td><td>${fmt(h.price)}</td><td class="${dirClass(h.returnPct)}">${signed(h.returnPct)}%</td></tr>`).join('')}
      </tbody></table></div>
      <ul class="bt-notes"><li>Mỗi kỳ chỉ chọn mã đạt ngưỡng thanh khoản tại thời điểm đó, nhưng danh sách mã lấy từ các mã đang niêm yết hôm nay nên kết quả quá khứ vẫn có thể đẹp hơn thực tế (thiên lệch sống sót).</li>
        <li>Kiểm tra thực tế ở phần "Độ chính xác dự đoán" bên dưới: top 8 được ghi lại mỗi phiên và chấm bằng giá thật.</li></ul></div>
    </div>`;
  if (!window.LightweightCharts) return;
  if (RK.chart) { RK.chart.remove(); RK.chart = null; }
  const LC = window.LightweightCharts;
  const chart = LC.createChart($('rk-chart'), {
    autoSize: true,
    ...CHART_TOUCH,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') }, timeScale: { borderColor: css('--axis') },
    localization: { locale: 'vi-VN', priceFormatter: (v) => `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr` },
  });
  const line = (color, w) => chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false });
  line(css('--muted'), 1).setData(r.curve.map((p) => ({ time: p.time, value: p.index })));
  line(css('--s2'), 2).setData(r.curve.map((p) => ({ time: p.time, value: p.equalWeight })));
  line(css('--accent'), 3).setData(r.curve.map((p) => ({ time: p.time, value: p.equity })));
  chart.timeScale().fitContent();
  RK.chart = chart;
}

// Kiểm chứng các giả thuyết chọn trước: chỉ các dòng này dùng để kết luận, bảng nguồn bên dưới là khám phá thêm
const VERDICT = {
  insufficient: ['muted', 'Chưa đủ dữ liệu'], supported: ['up', 'Ủng hộ'], rejected: ['down', 'Bác bỏ'], inconclusive: ['', 'Chưa kết luận'],
};
function verificationHtml(v) {
  if (!v?.hypotheses) return '';
  const val = (h) => (h.mean == null ? '–' : h.id === 'H1' || h.id === 'H5' || h.id === 'H6' ? fmt(h.mean, 3) : h.id === 'H3' ? `${fmt(h.coverage * 100, 0)}% phủ` : pct(h.mean));
  const remain = (h) => {
    if (h.verdict === 'supported' || h.verdict === 'rejected') return '–';
    const need = h.needDatesPrior ?? h.needDates;
    return need == null ? '–' : `~${Math.max(0, need - h.n)} phiên${h.needDates && h.needDatesPrior ? ` <span class="muted small">(theo mức đang đo: ~${Math.max(0, h.needDates - h.n)})</span>` : ''}`;
  };
  const rows = v.hypotheses.map((h) => {
    const [cls, txt] = VERDICT[h.verdict] || ['', h.verdict];
    return `<tr><td style="font-family:inherit"><b>${h.id}</b> ${esc(h.title)}</td><td>${h.n}</td><td>${val(h)}</td><td>${h.t ?? '–'}</td>
      <td class="${cls}" style="font-family:inherit"><b>${txt}</b>${h.note ? ` · ${esc(h.note)}` : ''}</td><td>${remain(h)}</td></tr>`;
  }).join('');
  const calib = v.calibration.filter((c) => c.n).map((c) => `<tr><td>${c.source}</td>${c.groups.map((g) => `<td>${g.n ? `${fmt(g.hitRate * 100, 0)}% <span class="muted small">/ ${g.n}</span>` : '–'}</td>`).join('')}</tr>`).join('');
  return `<h3 style="margin:0 0 6px">Kiểm chứng giả thuyết chính</h3>
    <p class="muted small" style="margin:0 0 8px">Mua giá mở cửa phiên sau dự đoán. Mỗi phiên tính một giá trị, kiểm định bằng t Newey-West (cửa sổ chồng nhau);
      |t| ≥ 2 và ≥ ${v.rules.minDates} phiên mới kết luận. "Còn cần" = số phiên nữa để đủ ý nghĩa nếu hiệu ứng thật bằng mức giả định.</p>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Giả thuyết</th><th>Số phiên</th><th>Ước lượng</th><th>t</th><th>Kết luận</th><th>Còn cần</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted small" style="margin:6px 0 14px">IC điểm xếp hạng: 5 phiên ${v.ic[5].mean ?? '–'} (t ${v.ic[5].t ?? '–'}, ${v.ic[5].n} phiên) · 10 phiên ${v.ic[10].mean ?? '–'} · 20 phiên ${v.ic[20].mean ?? '–'}.
      Phiên bản mô hình: ${Object.entries(v.versions).map(([k, n]) => `${esc(k)} (${n})`).join(', ')}.</p>
    ${calib ? `<details style="margin-bottom:14px"><summary class="muted small" style="cursor:pointer">Độ tự tin của AI có đúng không (tỷ lệ đúng so rổ, 10 phiên)</summary>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nguồn</th><th>Tự tin thấp (&lt;60)</th><th>Vừa (60–74)</th><th>Cao (≥75)</th></tr></thead><tbody>${calib}</tbody></table></div></details>` : ''}
    ${exploreHtml(v.explore)}`;
}

// Phần khám phá: con số % có sát không, kế hoạch lệnh, từng bộ lọc của phễu Tiềm năng, tác động của tin
function exploreHtml(x) {
  if (!x) return '';
  const tv = (t) => (t?.t == null ? '–' : `${t.mean != null ? signed(t.mean * 100, 2) + '%' : '–'} <span class="muted small">t ${t.t} · ${t.n} phiên</span>`);
  const pctRows = x.pct.map((r) => `<tr><td style="font-family:inherit">${esc(r.kind)} · ${r.source}</td><td>${r.h}</td><td>${r.n ?? 0} <span class="muted small">/ ${r.recorded}</span></td>
    <td>${r.meanPred != null ? signed(r.meanPred * 100, 1) + '%' : '–'}</td><td>${r.meanActual != null ? signed(r.meanActual * 100, 1) + '%' : '–'}</td>
    <td>${r.mae != null ? `${fmt(r.mae * 100, 1)}% <span class="muted small">(đoán 0%: ${fmt(r.maeNaive * 100, 1)}%)</span>` : '–'}</td><td>${r.slope ?? '–'}</td></tr>`).join('');
  const planRows = x.plans.map((r) => `<tr><td>${r.source}</td><td>${r.done}/${r.recorded}</td><td>${r.noFill}</td><td>${r.filled}</td>
    <td>${r.targetRate != null ? fmt(r.targetRate * 100, 0) + '%' : '–'} <span class="muted small">${r.target} chạm · ${r.stop} cắt lỗ · ${r.time} hết hạn</span></td>
    <td>${r.avgRet != null ? signed(r.avgRet * 100, 1) + '%' : '–'}</td><td>${r.avgTargetPct != null ? signed(r.avgTargetPct * 100, 1) + '%' : '–'}</td></tr>`).join('');
  const filt = x.filters.filter((r) => r.h === 20).map((r) => {
    const r5 = x.filters.find((y) => y.key === r.key && y.h === 5);
    return `<tr><td style="font-family:inherit">${esc(r.label)}</td><td>${r.passed}/${r.passed + r.failed}</td><td>${tv(r5)}</td><td>${tv(r)}</td><td>${(VERDICT[r.verdict] || ['', ''])[1]}</td></tr>`;
  }).join('');
  const news = x.news.map((r) => `<tr><td style="font-family:inherit">${esc(r.label)}</td><td>${r.events}</td><td>${r.gap != null ? signed(r.gap * 100, 2) + '%' : '–'}</td><td>${tv(r[1])}</td><td>${tv(r[5])}</td><td>${tv(r[20])}</td></tr>`).join('');
  const box = (title, note, head, rows, empty) => `<details style="margin-bottom:10px"><summary class="muted small" style="cursor:pointer">${title}</summary>
    <p class="muted small" style="margin:6px 0">${note}</p>${rows ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted small">${empty}</p>`}</details>`;
  return `<h3 style="margin:14px 0 6px">Khám phá thêm (chưa dùng để kết luận)</h3>
    ${box('Con số % dự báo có sát không', 'So % dự báo với thực tế cùng cách tính. Hệ số (slope) 1 là chuẩn, nhỏ hơn 1 là dự báo phóng đại; sai số phải nhỏ hơn cách "đoán 0%" mới có ích.',
      ['Loại · nguồn', 'Phiên', 'Đã chấm / đã ghi', 'Dự báo TB', 'Thực tế TB', 'Sai số TB', 'Hệ số'], pctRows, 'Chưa có dự báo % nào được ghi (bắt đầu từ lần khởi động lại server).')}
    ${box('Kế hoạch lệnh: khớp, chạm mục tiêu hay cắt lỗ', 'Mua giới hạn ở cận trên vùng mua (hiệu lực 5 phiên); đóng cửa dưới cắt lỗ thì bán mở cửa phiên sau; chạm mục tiêu thì bán; hết số phiên thì bán.',
      ['Nguồn', 'Đã chấm', 'Không khớp', 'Đã khớp', 'Chạm mục tiêu', 'Lãi thật TB', 'Mục tiêu hứa TB'], planRows, 'Chưa có kế hoạch nào đủ phiên để chấm.')}
    ${box('Bộ lọc Tiềm năng: nhóm đạt hơn nhóm rớt bao nhiêu', 'Mỗi phiên lấy chênh lãi hơn rổ giữa mã đạt và mã rớt bộ lọc trong cùng lần quét; dương có ý nghĩa = bộ lọc giúp chọn mã tốt hơn.',
      ['Bộ lọc', 'Đạt', 'Sau 5 phiên', 'Sau 20 phiên', 'Kết luận (20 phiên)'], filt, 'Chưa có dữ liệu phễu (ghi từ lần quét Tiềm năng kế tiếp).')}
    ${box(`Tác động của tin tức (${x.newsEvents} tin đã thu thập)`, 'Lãi bất thường = lãi của mã từ giá mở cửa phiên đầu tiên sau giờ đăng tin, trừ lãi rổ cùng thời gian. "Gap" = giá đã chạy bao nhiêu trước khi kịp mua.',
      ['Nhóm tin', 'Số tin', 'Gap TB', 'Sau 1 phiên', 'Sau 5 phiên', 'Sau 20 phiên'], news, 'Chưa có tin nào đủ phiên để đo.')}`;
}

async function loadPredictions() {
  $('pd-body').innerHTML = '<p class="muted">Đang chấm các dự đoán…</p>';
  try {
    const [p, v] = await Promise.all([api('/api/predictions'), api('/api/verification').catch(() => null)]);
    const cell = (x) => {
      if (!x.evaluated) return '<td class="muted">chưa đủ phiên</td>';
      if (x.beatIndexRate == null) return `<td>${fmt(x.hitRate * 100, 0)}% <span class="muted small">đúng hướng / ${x.evaluated}</span></td>`;
      const beat = x.beatIndexRate * 100;
      const ex = [x.buyAvgExcess != null ? `mua ${pct(x.buyAvgExcess)}` : '', x.sellAvgExcess != null ? `tránh ${pct(x.sellAvgExcess)}` : ''].filter(Boolean).join(' · ');
      const exB = [x.buyAvgExcessBasket != null ? `mua ${pct(x.buyAvgExcessBasket)}` : '', x.sellAvgExcessBasket != null ? `tránh ${pct(x.sellAvgExcessBasket)}` : ''].filter(Boolean).join(' · ');
      const basket = x.beatBasketRate == null ? '' : `<div class="small"><b class="${x.beatBasketRate >= 0.55 ? 'up' : x.beatBasketRate < 0.45 ? 'down' : ''}">${fmt(x.beatBasketRate * 100, 0)}%</b> <span class="muted">đúng so rổ${exB ? ` · ${exB}` : ''}</span></div>`;
      return `<td><b class="${beat >= 55 ? 'up' : beat < 45 ? 'down' : ''}">${fmt(beat, 0)}%</b> <span class="muted small">đúng so VNI / ${x.evaluated}</span>
        ${basket}<div class="muted small">${ex ? `${ex} so VNI · ` : ''}đúng hướng giá ${fmt(x.hitRate * 100, 0)}%</div></td>`;
    };
    const RES = (it) => {
      const h = [5, 10, 20].filter((k) => it.result?.[k]);
      if (!it.direction) return '<span class="muted">trung tính</span>';
      if (!h.length) return '<span class="muted">chờ</span>';
      return h.map((k) => {
        const r = it.result[k], ok = r.beatIndex ?? r.correct;
        return `<span class="${ok ? 'up' : 'down'}" title="Giá ${pct(r.ret)}${r.excess != null ? `, so VN-Index ${pct(r.excess)}` : ''}${r.excessBasket != null ? `, so rổ ${pct(r.excessBasket)}` : ''}">${k}p ${ok ? '✓' : '✕'} ${pct(r.excess ?? r.ret)}</span>`;
      }).join(' · ');
    };
    $('pd-body').innerHTML = `${verificationHtml(v)}
      <h3 style="margin:0 0 6px">Độ chính xác từng nguồn (khám phá)</h3>
      <p class="muted small" style="margin:0 0 10px">Đã ghi ${p.totalItems} dự đoán${p.firstDate ? ` từ ${p.firstDate}` : ''}. "Đúng so VNI" = mã khuyên mua tăng hơn VN-Index, hoặc mã khuyên tránh/bán kém VN-Index trong cùng khoảng
        (khuyến nghị là so với thị trường: khi cả thị trường tăng mạnh, mã "tránh" vẫn có thể tăng nhưng tăng ít hơn).
        "Đúng so rổ" chấm tương tự nhưng so với lãi trung bình đồng tỷ trọng của cả rổ theo dõi — công bằng hơn khi vài mã vốn hóa lớn kéo VN-Index.
        "Đúng hướng giá" chấm theo giá tăng/giảm tuyệt đối. Tỷ lệ ngẫu nhiên ≈ 50%; cần ít nhất vài chục dự đoán đã chấm mới đáng tin.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nguồn dự đoán</th><th>Đã ghi</th><th>Đang chờ</th><th>Sau 5 phiên</th><th>Sau 10 phiên</th><th>Sau 20 phiên</th></tr></thead><tbody>
        ${p.summary.map((s) => `<tr><td style="font-family:inherit"><b>${esc(s.label)}</b></td><td>${s.total}</td><td>${s.pending}</td>${s.horizons.map(cell).join('')}</tr>`).join('')}
      </tbody></table></div>
      ${p.recent.length ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Dự đoán gần đây (${p.recent.length})</summary>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Phiên</th><th>Nguồn</th><th>Mã</th><th>Dự đoán</th><th>Giá</th><th>Kết quả</th></tr></thead><tbody>
        ${p.recent.map((it) => `<tr><td>${it.date}</td><td style="font-family:inherit">${esc(p.summary.find((s) => s.source === it.source)?.label || it.source)}</td>
          <td><a href="#${it.symbol}" class="pf-sym" data-sym="${it.symbol}">${it.symbol}</a></td>
          <td class="${it.direction > 0 ? 'up' : it.direction < 0 ? 'down' : ''}" style="font-family:inherit">${esc(it.label)}</td><td>${fmt(it.price)}</td><td>${RES(it)}</td></tr>`).join('')}
        </tbody></table></div></details>` : ''}`;
  } catch (err) {
    $('pd-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('pd-refresh')?.addEventListener('click', loadPredictions);
$('pd-body')?.addEventListener('click', (e) => {
  const s = e.target.closest('.pf-sym');
  if (s) { e.preventDefault(); analyze(s.dataset.sym); }
});
$('rank-btn')?.addEventListener('click', showRankView);

// ---------- Tóm tắt nhanh mỗi mã ----------
const BRIEF_ICON = { up: '▲', down: '▼', ref: '•' };
const DECISION_TONE = { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down', MUA: 'up', MUA_THAM_DO: 'up', GIU: 'ref', DUNG_NGOAI: 'down', BAN_BOT: 'down', BAN: 'down' };

// ---------- Mục chi tiết gập lại: mỗi mục một dòng tóm tắt ----------
function setFold(id, text, tone = '') {
  const el = $(`${id}-sum`);
  if (!el) return;
  el.textContent = text || '';
  el.className = `fold-sum ${tone}`;
}
// Ẩn mục không có nội dung (ví dụ VN-Index không có BCTC, khối ngoại…)
function syncFolds() {
  document.querySelectorAll('#folds > details.fold').forEach((d) => {
    const cards = [...d.querySelectorAll(':scope > .fold-body > .card, :scope > .fold-body > section')];
    d.hidden = cards.length > 0 && cards.every((c) => c.hidden);
  });
}
const short = (t, n = 90) => {
  const x = String(t || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x;
};

/** Thẻ quyết định: kết luận, một câu nên làm gì, 4 con số và tối đa 3 lý do. */
function renderQuick(a) {
  const b = a.brief, eff = b ? effectiveBrief(a) : null;
  const tone = eff?.tone || (a.recommendation.code === 'BUY' || a.recommendation.code === 'ACCUMULATE' ? 'up' : a.recommendation.code === 'HOLD' ? 'ref' : 'down');
  const verdict = eff?.verdict || a.recommendation.label;
  $('qc-verdict').className = `qc-verdict ${tone}`;
  $('qc-verdict').textContent = `${BRIEF_ICON[tone]} ${verdict}`;
  $('qc-action').textContent = short(eff?.action || a.recommendation.desc, 160);

  const l = b?.levels || {}, close = a.price.close;
  const code = eff?.fin?.code ?? b?.code ?? a.recommendation.code;
  const buying = code === 'BUY' || code === 'ACCUMULATE';
  const entry = l.buyFrom != null ? { from: l.buyFrom, to: l.buyTo } : a.plan?.entryZone;
  const stop = l.holdStop ?? l.stop ?? a.plan?.hold?.warnStop;
  const wait = eff?.steps?.fresh?.find((x) => x.side === 'wait')?.condition;
  const br = a.marketRegime?.breadth?.pctAboveMa50;
  const r = a.ranking;
  const tile = (k, v, sub, cls = '') => `<div class="qc-tile ${cls}"><span class="k">${k}</span><b class="v">${v}</b><span class="s">${sub}</span></div>`;
  $('qc-tiles').innerHTML = [
    !a.isIndex && (buying
      ? tile('Vùng mua', entry ? (entry.from === entry.to ? fmt(entry.to) : `${fmt(entry.from)} – ${fmt(entry.to)}`) : '–', entry && close >= entry.from && close <= entry.to ? 'Giá đang trong vùng' : 'Chờ giá về vùng', 'up')
      : tile('Mua mới', 'Chưa nên', esc(short(wait, 48) || 'Chưa đủ điều kiện'), 'ref')),
    !a.isIndex && stop && tile('Ngưỡng thoát', fmt(stop), `${signed((stop / close - 1) * 100, 1)}% · đóng cửa dưới thì bán`, 'down'),
    r && tile('Điểm xếp hạng', `${r.score}/100`, `hạng ${r.position}/${r.universe} toàn sàn`, r.score >= 70 ? 'up' : r.score < 40 ? 'down' : ''),
    br != null && tile('Thị trường', `${Math.round(br)}% mã khỏe`, br < 50 ? 'Yếu: không mua mới' : 'Đủ mạnh để mua', br < 50 ? 'down' : 'up'),
  ].filter(Boolean).join('');

  // Lý do: ưu tiên các yếu tố đã kiểm định, xấu trước nếu kết luận xấu
  const bad = [], good = [];
  if (r?.avoid) bad.push('Thuộc 10% mã điểm thấp nhất sàn');
  if (a.stockRisk?.isRisky) bad.push(`Đang rơi mạnh: ${a.stockRisk.reasons[0]}`);
  for (const w of a.buyWarnings || []) bad.push(`${w.name}: ${w.text}`);
  if (r?.aboveMa200 === false) bad.push('Giá dưới MA200: xu hướng dài hạn xấu');
  if (a.foreign?.net5 != null && a.foreign.net5 < -50e9) bad.push(`Khối ngoại bán ròng ${fmt(-a.foreign.net5 / 1e9, 0)} tỷ trong 5 phiên`);
  if (r?.trendPick) good.push('Xu hướng chuẩn: gần đỉnh 52 tuần, biến động êm');
  if (r && r.score >= 70 && r.aboveMa200 !== false) good.push(`Thuộc nhóm dẫn đầu sàn (điểm ${r.score})`);
  if (r?.aboveMa200 === true) good.push('Giá trên MA200: xu hướng dài hạn tốt');
  for (const [k, label] of RANK_PART_LABEL) if ((r?.parts?.[k] ?? 0) >= 80) good.push(`${label} mạnh`);
  const first = tone === 'up' ? good : bad, second = tone === 'up' ? bad : good;
  const why = [...first.map((t) => [tone === 'up' ? 'up' : 'down', t]), ...second.map((t) => [tone === 'up' ? 'down' : 'up', t])].slice(0, 3);
  $('qc-why').innerHTML = why.map(([t, x]) => `<li class="${t}"><span aria-hidden="true">${t === 'up' ? '▲' : '▼'}</span>${esc(short(x))}</li>`).join('');
  $('qc-why').hidden = !why.length;

  setFold('sec-plan', short(eff?.action, 70));
  syncFolds();
}

$('qc-alert-btn')?.addEventListener('click', () => {
  const d = $('sec-alerts');
  d.open = true;
  d.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('folds-toggle')?.addEventListener('click', (e) => {
  const all = [...document.querySelectorAll('#folds > details.fold:not([hidden])')];
  const open = !all.every((d) => d.open);
  all.forEach((d) => { d.open = open; });
  e.target.textContent = open ? 'Gập tất cả' : 'Mở tất cả';
});
// Mở mục có biểu đồ: canh lại kích thước biểu đồ
document.querySelectorAll('#folds > details.fold').forEach((d) => d.addEventListener('toggle', () => {
  if (!d.open || !state.current) return;
  if (d.id === 'sec-foreign') renderForeignChart(state.current);
}));

function briefText(a) {
  const b = { ...a.brief, ...(() => { const e = effectiveBrief(a); return { verdict: e.verdict, action: e.action, steps: e.steps, fin: e.fin }; })() }, l = b.levels;
  const lines = [`${a.symbol} — ${b.verdict} (${b.headline}) · giá ${fmt(a.price.close)} ngày ${a.price.date}`, `→ ${b.action}`];
  if (b.fin) {
    lines.push(`AI thẩm định: ${b.fin.note}`);
    for (const c of b.fin.marketChecks) lines.push(`  ${CHECK_ICON[c.status][0]} ${c.label}: ${c.note}`);
  }
  const stepLine = (x) => `  - [${SIDE[x.side][0]}] ${x.zone ? `${fmt(x.zone[0])}–${fmt(x.zone[1])}` : x.price != null ? fmt(x.price) : ''}${x.portion ? ` · ${Math.round(x.portion * 100)}% vốn` : x.side === 'buy' && x.portionOfHolding ? ` · +${Math.round(x.portionOfHolding * 100)}% số đang giữ` : ''}${(() => { const q = stepQty(x, capitalM() * 1e6); return q?.shares ? ` · ${q.shares.toLocaleString('vi-VN')} cp ≈ ${money(q.vnd)}` : ''; })()} · ${x.condition}`;
  if (b.steps) {
    lines.push('Nếu CHƯA có cổ phiếu:', ...b.steps.fresh.map(stepLine));
    lines.push(`Nếu ĐANG nắm giữ:${b.plays?.position ? ` (${b.plays.position})` : ''}`);
    const h = b.fin?.holder;
    if (h) {
      lines.push(`  ${h.addLabel}: ${h.addReason}`);
      if (h.holdView) lines.push(`  ${h.holdView}`);
      for (const z of h.noAdd) lines.push(`  Không mua thêm khi giá ${z.side === 'DUOI' ? 'dưới' : 'trên'} ${fmt(z.price)}: ${z.reason}`);
    }
    lines.push(...b.steps.hold.map(stepLine));
  }
  lines.push('Vì sao:');
  for (const r of b.reasons) lines.push(`${BRIEF_ICON[r.tone]} ${r.text}`);
  if (l) lines.push(`Bậc thang giá: KC2 ${fmt(l.r2)} · KC1 ${fmt(l.r1)} · giá ${fmt(l.close)} · HT1 ${fmt(l.s1)}${l.s2 != null ? ` · HT2 ${fmt(l.s2)}` : ''} · cắt lỗ ${fmt(l.stop)}`);
  if (b.risks.length) lines.push(`Rủi ro: ${b.risks.join('; ')}`);
  return lines.join('\n');
}

// Vốn dùng để quy đổi tỷ trọng ra số cổ phiếu (lưu trên trình duyệt này)
const capitalM = () => { try { return Number(localStorage.getItem('vnstock_capital')) || 0; } catch { return 0; } };
const SIDE = { buy: ['Mua', 'up'], sell: ['Bán', 'down'], stop: ['Cảnh báo', 'down'], wait: ['Chờ', 'ref'] };

/** Số tiền dễ đọc: 1,25 tỷ · 125,4 triệu · 850 nghìn. */
function money(vnd) {
  const v = Math.abs(vnd);
  if (v >= 1e9) return `${(vnd / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (v >= 1e6) return `${(vnd / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} triệu`;
  return `${Math.round(vnd / 1e3).toLocaleString('vi-VN')} nghìn`;
}

/** Số cp mua được với số tiền (giá nghìn đồng): ưu tiên lô chẵn 100, không đủ thì lô lẻ. */
function sharesFor(vnd, price) {
  const raw = Math.floor(vnd / (price * 1000));
  const shares = raw >= 100 ? Math.floor(raw / 100) * 100 : raw;
  return { shares, odd: shares > 0 && shares < 100 };
}

/**
 * Quy đổi một bước ra số cp và số tiền. Mua mới: tỷ trọng × vốn, tính theo giá CAO nhất của vùng để không vượt tiền.
 * Bước đã có số cp (theo vị thế thật): số tiền = số cp × giá.
 */
function stepQty(x, cap) {
  const price = x.zone ? (x.side === 'buy' ? x.zone[1] : (x.zone[0] + x.zone[1]) / 2) : x.price;
  if (!price) return null;
  if (x.shares != null) return { shares: x.shares, vnd: x.shares * price * 1000, odd: x.shares < 100 };
  if (x.side === 'buy' && x.portion && cap) {
    const { shares, odd } = sharesFor(cap * x.portion, price);
    return { shares, vnd: shares * price * 1000, odd, budget: cap * x.portion };
  }
  return null;
}

function stepRows(steps, { close }) {
  const cap = capitalM() * 1e6;
  let n = 0;
  return steps.map((x) => {
    const [label, tone] = SIDE[x.side];
    const zone = x.zone ? `${fmt(x.zone[0])}–${fmt(x.zone[1])}` : x.price != null ? fmt(x.price) : '–';
    const ref = x.zone ? (x.zone[0] + x.zone[1]) / 2 : x.price;
    const diff = ref ? ` <span class="muted small">${pct((ref - close) / close)}</span>` : '';
    const q = stepQty(x, cap);
    let qty = '', amount = '';
    if (q) {
      qty = q.shares > 0 ? `<b>${q.shares.toLocaleString('vi-VN')} cp</b>${q.odd ? ' <span class="muted small">(lô lẻ)</span>' : ''}` : '<span class="down small">vốn không đủ 1 cp</span>';
      const sign = x.side === 'buy' ? 'chi' : 'thu về';
      amount = q.shares > 0 ? `${money(q.vnd)} <span class="muted small">${sign}</span>` : '';
      if (x.side === 'buy' && cap && !x.portion) amount += ` <span class="muted small">= ${pct(q.vnd / cap).replace('+', '')} vốn</span>`;
    } else if (x.side === 'buy' && x.portion && !cap) qty = '<span class="muted small">nhập vốn</span>';
    const weight = x.portion ? `<b>${Math.round(x.portion * 1000) / 10}%</b> vốn`
      : x.portionOfHolding ? (x.side === 'buy' ? `+${Math.round(x.portionOfHolding * 100)}% số đang giữ` : `${Math.round(x.portionOfHolding * 100)}% số đang giữ`) : '';
    const num = x.side === 'buy' || x.side === 'sell' ? ++n : '';
    return `<tr class="st-${x.side}"><td class="st-n">${num}</td><td><span class="st-badge ${tone}">${label}</span></td>
      <td class="st-zone">${zone}${diff}</td><td>${weight}</td><td>${amount}</td><td>${qty}</td><td class="st-cond">${esc(x.condition)}</td></tr>`;
  }).join('');
}

/** Khung vốn: nhập số tiền → quy ra tỷ trọng, số tiền, số cp, mức lỗ tối đa và tỷ trọng vị thế đang giữ. */
function capitalBox(a, steps) {
  const capM = capitalM() || 500;
  const cap = capM * 1e6;
  const l = a.brief.levels;
  const close = a.price.close;
  const h = a.brief.holding;
  const chips = [100, 200, 500, 1000].map((v) => `<button type="button" class="btn btn-glass btn-xs${v === capM ? ' on' : ''}" data-cap="${v}">${money(v * 1e6)}</button>`).join('');
  const head = `<div class="cap-head">
      <label for="bf-capital"><b>💰 Tổng vốn đầu tư của bạn</b></label>
      <span class="cap-input"><input id="bf-capital" type="number" min="0" step="10" inputmode="decimal" value="${capM || ''}" placeholder="vd 500"> triệu đồng</span>
      <span class="cap-chips">${chips}</span>
      ${cap ? `<span class="muted small">= ${Math.round(cap).toLocaleString('vi-VN')} đ</span>` : ''}
    </div>`;
  if (!cap) {
    return `<div class="bf-capbox">${head}
      <div class="muted small">Nhập tổng số tiền bạn dành cho chứng khoán (ví dụ 500 = 500 triệu). Tool sẽ đổi tỷ trọng % thành <b>số tiền</b> và <b>số cổ phiếu</b>
      cho từng lần mua, cho biết <b>lỗ tối đa bao nhiêu tiền</b> nếu chạm cắt lỗ, và vị thế đang giữ chiếm bao nhiêu % vốn. Chỉ lưu trên trình duyệt này.</div></div>`;
  }
  const rows = [];
  // Tỷ trọng tối đa cho mã này (theo khoảng cách tới cắt lỗ: chạm cắt lỗ chỉ mất ~1% tổng vốn)
  if (l?.weight != null) {
    const maxV = cap * l.weight;
    const { shares } = sharesFor(maxV, close);
    rows.push(['Tỷ trọng tối đa cho ' + a.symbol, `<b>${Math.round(l.weight * 1000) / 10}% vốn</b> = <b>${money(maxV)}</b> ≈ ${shares.toLocaleString('vi-VN')} cp ở giá ${fmt(close)}`]);
  }
  // Kế hoạch mua mới
  const buys = (steps?.fresh || []).filter((x) => x.side === 'buy' && x.portion);
  const isWait = (steps?.fresh || []).some((x) => x.side === 'wait');
  if (buys.length) {
    const qs = buys.map((x) => ({ x, q: stepQty(x, cap) })).filter((r) => r.q);
    const totalV = qs.reduce((s, r) => s + r.q.vnd, 0);
    const totalSh = qs.reduce((s, r) => s + r.q.shares, 0);
    const totalW = buys.reduce((s, x) => s + x.portion, 0);
    const detail = qs.map((r, k) => `lần ${k + 1}: ${r.q.shares.toLocaleString('vi-VN')} cp (${money(r.q.vnd)})`).join(' · ');
    rows.push([isWait ? 'Nếu đủ điều kiện mua' : 'Kế hoạch mua mới', `tổng <b>${Math.round(totalW * 1000) / 10}% vốn</b> ≈ <b>${money(totalV)}</b> = <b>${totalSh.toLocaleString('vi-VN')} cp</b>, chia ${qs.length} lần<div class="muted small">${detail}</div>`]);
    if (l?.stop) {
      const loss = qs.reduce((s, r) => {
        const p = r.x.zone ? r.x.zone[1] : r.x.price;
        return s + r.q.shares * Math.max(0, p - l.stop) * 1000;
      }, 0);
      rows.push(['Rủi ro nếu chạm cắt lỗ ' + fmt(l.stop), `<span class="down">lỗ tối đa ≈ <b>${money(loss)}</b> = ${(loss / cap * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% tổng vốn</span> (chưa tính phí, thuế)`]);
    }
    rows.push(['Tiền mặt còn lại', `${money(cap - totalV)} cho các mã khác`]);
  } else {
    rows.push(['Mua mới', '<span class="ref">Quyết định hiện tại là chưa mua: không giải ngân vốn cho mã này</span>']);
  }
  // Vị thế đang giữ so với vốn
  if (h?.qty) {
    const val = h.qty * close * 1000;
    const w = val / cap;
    let note = '';
    if (l?.weight != null) {
      const room = cap * l.weight - val;
      note = room > 0
        ? ` · còn được mua thêm tối đa <b>${money(room)}</b> ≈ ${sharesFor(room, close).shares.toLocaleString('vi-VN')} cp (nếu kế hoạch cho phép)`
        : ` · <span class="down">đã vượt tỷ trọng tối đa ${Math.round(l.weight * 100)}%: không mua thêm, cân nhắc hạ bớt</span>`;
    }
    rows.push(['Vị thế đang giữ', `${h.qty.toLocaleString('vi-VN')} cp × ${fmt(close)} = <b>${money(val)}</b> = <b>${(w * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% vốn</b>${note}`]);
  }
  return `<div class="bf-capbox">${head}<div class="cap-rows">${rows.map(([k, v]) => `<div class="cap-k">${k}</div><div class="cap-v">${v}</div>`).join('')}</div></div>`;
}

function ladder(l) {
  const rows = [
    ['Kháng cự 2 / mục tiêu 2', l.r2, 'up'], ['Kháng cự 1 / mục tiêu 1', l.r1, 'up'], ['Giá hiện tại', l.close, 'now'],
    ['Hỗ trợ 1', l.s1, ''], ['Hỗ trợ 2', l.s2, ''], ['Ngưỡng cảnh báo −15%', l.stop, 'down'],
  ].filter((r) => r[1] != null);
  return `<div class="ld">${rows.map(([k, v, cls]) => `<div class="ld-row ${cls}"><span>${k}</span><b>${fmt(v)}</b><span class="muted small">${cls === 'now' ? '' : pct((v - l.close) / l.close)}</span></div>`).join('')}
    ${l.weight != null ? `<div class="ld-note">Tỷ trọng tối đa <b>${Math.round(l.weight * 100)}% vốn</b> (chạm cắt lỗ chỉ mất ~1% tổng vốn)${l.riskReward ? ` · lời/lỗ đến ${l.targetLabel || "mục tiêu"}: <b>${fmt(l.riskReward, 1)} lần</b>` : ''}</div>` : ''}</div>`;
}

const CHECK_ICON = { TOT: ['✓', 'up'], TRUNG_TINH: ['•', 'ref'], XAU: ['✕', 'down'] };

function effectiveBrief(a) {
  const b = a.brief;
  // Chỉ dùng quyết định cuối đã qua đủ Gemini và hội đồng đầu tư
  const fin = currentFinal(a);
  const ai = fin ? state.cmResult : null;
  if (!fin) return { verdict: b.verdict, tone: b.tone, action: b.action, steps: b.steps, fin: null, ai };
  return { verdict: fin.label, tone: fin.tone, action: fin.action, steps: fin.steps || b.steps, fin, ai };
}

const ADD_TONE = { MUA_THEM: 'up', MUA_THEM_CO_DIEU_KIEN: 'ref', KHONG_MUA_THEM: 'down' };

/** Phần "đang nắm giữ" do hội đồng lập: có nên mua thêm, vùng không được mua thêm, quan điểm giữ. */
function holderBlock(h) {
  if (!h) return '';
  const noAdd = h.noAdd.length ? `<ul class="bf-noadd">${h.noAdd.map((z) => `<li><b>Không mua thêm khi giá ${z.side === 'DUOI' ? 'dưới' : 'trên'} ${fmt(z.price)}</b>${z.reason ? `: ${esc(z.reason)}` : ''}</li>`).join('')}</ul>` : '';
  return `<div class="bf-holder">
    <div><span class="st-badge ${ADD_TONE[h.addMore]}">${esc(h.addLabel)}</span> ${esc(h.addReason)}</div>
    ${h.blocked ? `<div class="muted small">⚠ ${esc(h.blocked)}</div>` : ''}
    ${h.holdView ? `<div class="bf-holdview">${esc(h.holdView)}</div>` : ''}
    ${noAdd}
  </div>`;
}

function aiReviewBlock(a, eff) {
  const fin = eff.fin;
  let status;
  if (fin) {
    const cls = fin.relation === 'stricter' ? 'down' : fin.relation === 'looser' ? 'ref' : 'up';
    const icon = fin.relation === 'stricter' ? '⚠' : fin.relation === 'looser' ? 'ℹ' : '✓';
    const chain = `Hệ thống <b>${esc(fin.systemLabel)}</b> → Gemini <b>${esc(fin.gemini?.label || '')}</b>${fin.committee ? ` → Hội đồng <b>${esc(fin.committee.label)}</b>` : ''} → Quyết định cuối <b>${esc(fin.label)}</b>`;
    status = `<div class="bf-ai ${cls}"><b>${icon} Đã qua Gemini và hội đồng đầu tư:</b> ${esc(fin.note)}
      <div class="small" style="margin-top:4px">${chain}</div>
      <span class="muted small">${esc(eff.ai.model)} · ${new Date(eff.ai.createdAt).toLocaleString('vi-VN')}${eff.ai.price !== a.price.close ? ` · tại giá ${fmt(eff.ai.price)}, giá đã đổi` : ''}</span>
      <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Phân tích lại</button></div>`;
  } else if (!state.ai.enabled) {
    status = '<div class="bf-ai ref">Chưa bật AI: quyết định chỉ dựa trên tín hiệu định lượng. Thêm API key trong .env để Gemini và hội đồng đầu tư thẩm định.</div>';
  } else if (state.aiRunning === a.symbol) {
    status = `<div class="bf-ai ref"><span class="mini-spin"></span> ${esc(state.cmStage || 'Đang phân tích')}… Quy trình: Gemini (6 yếu tố thị trường) → phe mua/phe bán → giám đốc đầu tư. Bảng dưới đang là kế hoạch định lượng tạm thời, <b>chưa nên hành động</b> trước khi có quyết định cuối.</div>`;
  } else if (state.aiError?.symbol === a.symbol) {
    status = `<div class="bf-ai down">⚠ Chưa có quyết định cuối: AI lỗi (${esc(state.aiError.message)}). Kế hoạch dưới chỉ dựa trên định lượng, chưa nên hành động. <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Thử lại</button></div>`;
  } else {
    status = '<div class="bf-ai ref">Chưa có quyết định cuối cho phiên này (cần Gemini và hội đồng đầu tư thẩm định). <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Phân tích ngay</button></div>';
  }
  const checks = fin?.marketChecks?.length ? `<div class="bf-checks">${fin.marketChecks.map((c) => {
    const [ic, tone] = CHECK_ICON[c.status];
    return `<div class="bf-check" data-tone="${tone}"><span class="bf-ic" aria-hidden="true">${ic}</span><b>${esc(c.label)}</b><span>${esc(c.note)}</span></div>`;
  }).join('')}</div>` : '';
  return status + checks;
}

function mcAndRiskBlock(a) {
  let html = '';
  if (a.stockRisk?.isRisky) {
    html += `<div class="bf-ai down" style="margin-top:10px; border-left:4px solid var(--down); background:rgba(244,63,94,0.12)">
      <div style="font-size:13px; font-weight:700; color:var(--down-text); margin-bottom:4px;">🚨 CẢNH BÁO RỦI RO CAO (${esc(a.stockRisk.riskLevel)})</div>
      <div style="font-size:12.5px; line-height:1.4;">${esc(a.stockRisk.reasons.join(' · '))}. <b>Khuyến nghị: Tuyệt đối tránh bắt dao rơi, ưu tiên giữ tiền mặt.</b></div>
    </div>`;
  }
  // Kỳ vọng thống kê (bảng 4 năm, rổ theo thời điểm): con số % có căn cứ, thay cho "xác suất tăng" của mô phỏng
  const ex = a.expectation?.h20;
  const badge = a.trendPick ? '<span class="st-badge up" style="margin-left:6px">★ Trend Pick</span>' : '';
  if (ex) {
    const b = a.expectation.bucket, lo = Math.min(ex.p10, -0.15), hi = Math.max(ex.p90, 0.15);
    const at = (v) => Math.round(((v - lo) / (hi - lo)) * 1000) / 10;
    html += `<div class="bf-ai ref" style="margin-top:10px; border-radius:8px; padding:12px 14px; background:var(--surface-2); border:1px solid var(--border-light)">
      <div style="font-size:13px; margin-bottom:6px"><b>📊 Kỳ vọng thống kê 20 phiên</b>${badge}
        <span class="muted small"> · các mã cùng nhóm điểm ${b.from}–${b.to}, ${b.aboveMa200 ? 'trên' : 'dưới'} MA200, 4 năm (${ex.n.toLocaleString('vi-VN')} lần)</span></div>
      <div style="position:relative; height:12px; border-radius:6px; background:var(--surface-3); margin:10px 0 4px" title="80% số lần nằm trong dải này">
        <div style="position:absolute; left:${at(ex.p10)}%; width:${at(ex.p90) - at(ex.p10)}%; top:0; bottom:0; border-radius:6px; background:rgba(255,255,255,0.18)"></div>
        <div style="position:absolute; left:${at(0)}%; top:-3px; bottom:-3px; width:1px; background:var(--muted)" title="Bằng rổ"></div>
        <div style="position:absolute; left:calc(${at(ex.meanExcess)}% - 4px); top:2px; width:8px; height:8px; border-radius:50%; background:${ex.meanExcess >= 0 ? 'var(--up)' : 'var(--down)'}" title="Trung bình"></div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted)"><span>${pct(ex.p10, 0)}</span><span>bằng rổ</span><span>${pct(ex.p90, 0)}</span></div>
      <div class="small" style="margin-top:6px">Hơn rổ trung bình <b class="${dirClass(ex.meanExcess)}">${pct(ex.meanExcess)}</b> · 80% số lần từ ${pct(ex.p10)} đến ${pct(ex.p90)} · thắng rổ ${fmt(ex.pBeat * 100, 0)}% số lần${a.expectation.h5 ? ` · 5 phiên: ${pct(a.expectation.h5.meanExcess, 2)}` : ''}</div>
      <div class="muted small">${ex.significant ? 'Khác 0 có ý nghĩa thống kê.' : 'Chưa có ý nghĩa thống kê: lợi thế (nếu có) nhỏ hơn độ dao động.'} Đây là mặt bằng của cả nhóm, từng mã có thể lệch xa.</div>
    </div>`;
  } else if (a.ranking) {
    html += `<div class="muted small" style="margin-top:10px">📊 Kỳ vọng thống kê: đang dựng bảng 4 năm, mở lại sau ít phút.${badge}</div>`;
  }
  // Mô phỏng Monte Carlo đã bỏ xu hướng: chỉ đo biên độ và rủi ro, không dự báo hướng
  if (a.monteCarlo) {
    const mc = a.monteCarlo;
    const pLoss = Math.round(mc.probLoss7 * 100);
    html += `<div class="bf-ai ${pLoss >= 40 ? 'down' : 'ref'}" style="margin-top:10px; border-radius:8px; padding:10px 14px; background:var(--surface-2); border:1px solid var(--border-light)">
      <div style="font-size:13px"><b>🎲 Rủi ro 20 phiên</b> <span class="muted small">(mô phỏng theo biến động thực tế của mã, không dự báo hướng)</span></div>
      <div class="small" style="margin-top:6px; display:flex; gap:16px; flex-wrap:wrap">
        <span>Có lúc lỗ ≥ 7%: <b class="${pLoss >= 40 ? 'down' : ''}">${pLoss}%</b></span>
        <span>Mức sụt trung vị: <b class="down">${pct(mc.troughDdMedian / 100)}</b></span>
        <span>80% kết quả sau 20 phiên: ${pct(mc.finalRetP10 / 100)} … ${pct(mc.finalRetP90 / 100)}</span>
      </div>
    </div>`;
  }
  return html;
}

function renderPillarsChecklist(a) {
  const o = a.overview || [];
  const trend = o.find(x => x.key === 'trend') || { tone: 'ref', verdict: 'Đi ngang', detail: 'Đang tích lũy' };
  const flow = o.find(x => x.key === 'foreign' || x.key === 'money') || { tone: 'ref', verdict: 'Trung lập', detail: 'Cân bằng mua bán' };
  
  const fData = a.fundamental?.data;
  let faTone = 'ref';
  let faVerdict = 'Cơ bản trung bình';
  let faDetail = 'Đang cập nhật BCTC';
  if (fData) {
    const roe = fData.roe != null ? (fData.roe * 100).toFixed(1) : null;
    const pe = fData.pe != null ? fData.pe.toFixed(1) : null;
    const pGrowth = fData.profitGrowthTTM != null ? (fData.profitGrowthTTM * 100).toFixed(1) : null;
    faTone = (fData.profitGrowthTTM > 0.1 && (fData.roe || 0) > 0.15) ? 'up' : (fData.profitGrowthTTM < 0) ? 'down' : 'ref';
    faVerdict = faTone === 'up' ? 'Tăng trưởng tốt' : faTone === 'down' ? 'Tăng trưởng giảm' : 'Trung bình';
    faDetail = `P/E ${pe || '–'} · ROE ${roe ? roe + '%' : '–'} · LN 4 quý ${pGrowth ? (pGrowth > 0 ? '+' : '') + pGrowth + '%' : '–'}`;
  }

  return `
    <div class="bf-pillars-card">
      <div class="pillar-row">
        <div class="pillar-label">📊 <b>Kỹ thuật (TA)</b></div>
        <div class="pillar-val">
          <span class="pillar-tag ${trend.tone}">${esc(trend.verdict)}</span>
          <span class="pillar-desc">${esc(trend.detail)}</span>
        </div>
      </div>
      <div class="pillar-row">
        <div class="pillar-label">🌊 <b>Dòng tiền (Flow)</b></div>
        <div class="pillar-val">
          <span class="pillar-tag ${flow.tone}">${esc(flow.verdict)}</span>
          <span class="pillar-desc">${esc(flow.detail)}</span>
        </div>
      </div>
      <div class="pillar-row">
        <div class="pillar-label">🏢 <b>Doanh nghiệp (FA)</b></div>
        <div class="pillar-val">
          <span class="pillar-tag ${faTone}">${esc(faVerdict)}</span>
          <span class="pillar-desc">${esc(faDetail)}</span>
        </div>
      </div>
    </div>
  `;
}

function renderBrief(a) {
  const el = $('brief-card');
  const b = a.brief;
  el.hidden = !b;
  if (state.current?.symbol === a.symbol) renderQuick(a);
  if (!b) return;
  const eff = effectiveBrief(a);
  const l = b.levels, st = eff.steps;
  const table = (steps) => `<table class="tbl st-table"><thead><tr><th>#</th><th></th><th>Vùng giá</th><th>Tỷ trọng</th><th>Số tiền</th><th>Số cp</th><th>Điều kiện</th></tr></thead>
    <tbody>${stepRows(steps, { close: a.price.close })}</tbody></table>`;
  el.className = `card brief-card tone-${eff.tone}`;

  const close = a.price.close;
  // Chỉ hiện vùng mua / tỷ trọng như lời khuyên mua khi quyết định (cuối cùng nếu có) là mua
  const code = eff.fin?.code ?? b.code;
  const buying = code === 'BUY' || code === 'ACCUMULATE';
  const entry = l?.buyFrom != null ? { from: l.buyFrom, to: l.buyTo } : a.plan?.entryZone || (l?.s1 ? { from: l.s1, to: close } : null);
  // Ngưỡng cảnh báo của luật nắm giữ (−15% theo giá đóng cửa), không phải cắt lỗ sát
  const stop = l?.holdStop ?? l?.stop ?? a.plan?.hold?.warnStop;
  const stopPct = stop && close ? stop / close - 1 : null;
  // Kháng cự gần chỉ để tham khảo: luật nắm giữ không chốt lời theo mốc giá
  const target = l?.target ?? l?.r1 ?? a.plan?.target;
  const inZone = entry && close >= entry.from && close <= entry.to;
  const reward = target ? target / close - 1 : null;
  const holdN = l?.holdSessions ?? a.plan?.hold?.reviewAfter ?? 40;

  const wait = st?.fresh?.find((x) => x.side === 'wait')?.condition;
  const weightStr = !buying ? 'Không mua mới' : l?.weight === 0 ? '0% vốn' : l?.weight != null ? `${Math.round(l.weight * (code === 'ACCUMULATE' ? 50 : 100))}% vốn` : '–';
  const weightSub = !buying ? 'Chỉ áp dụng khi có tín hiệu mua'
    : `1 suất · tối đa ${l?.sizing?.slots ?? 7} mã, 3 mã/ngành${l?.sizing && !l.sizing.capitalKnown ? ' · đặt ACCOUNT_CAPITAL để tính theo vốn' : ''}`;

  el.innerHTML = `
    <div class="bf-top">
      <div class="bf-verdict ${eff.tone}">${BRIEF_ICON[eff.tone]} ${esc(eff.verdict)}</div>
      <div class="bf-main">
        <div class="bf-action">${esc(eff.action)}</div>
        <div class="muted small">${esc(b.headline)} · giá ${fmt(a.price.close)} (${signed(a.price.changePct)}%) · phiên ${a.price.date}</div>
      </div>
      <button type="button" class="btn btn-glass btn-xs" id="bf-copy" title="Sao chép kế hoạch để gửi nhanh">📋 Sao chép</button>
    </div>

    <!-- 1. BẢNG 4 MỨC GIÁ HÀNH ĐỘNG -->
    <div class="bf-key-metrics">
      ${buying ? `<div class="bf-metric-card primary">
        <span class="m-label">🎯 Vùng mua an toàn</span>
        <span class="m-val">${entry ? (entry.from === entry.to ? `LO ${fmt(entry.to)}` : `${fmt(entry.from)} – ${fmt(entry.to)}`) : '–'}</span>
        <span class="m-sub ${inZone ? 'up' : ''}">${inZone ? '● Đang trong vùng mua' : entry && close > entry.to ? `Chờ chỉnh (${signed(((entry.to - close) / close) * 100, 1)}%)` : 'Chờ tích lũy'}</span>
      </div>` : `<div class="bf-metric-card">
        <span class="m-label">⏸ Tình trạng mua</span>
        <span class="m-val">Chưa kích hoạt</span>
        <span class="m-sub">${esc(wait || 'Chưa đủ điều kiện mua')}</span>
      </div>`}
      <div class="bf-metric-card down">
        <span class="m-label">🛑 Ngưỡng thoát</span>
        <span class="m-val">${fmt(stop)}</span>
        <span class="m-sub">${stopPct != null ? `${(stopPct * 100).toFixed(1)}%` : '–'} · Đóng cửa dưới mức này thì bán phiên sau</span>
      </div>
      <div class="bf-metric-card accent">
        <span class="m-label">⏳ Thời gian giữ</span>
        <span class="m-val">${holdN} phiên</span>
        <span class="m-sub">Hết kỳ còn trong nhóm mua thì giữ tiếp, không thì bán</span>
      </div>
      <div class="bf-metric-card">
        <span class="m-label">📍 Kháng cự gần</span>
        <span class="m-val">${fmt(target)}</span>
        <span class="m-sub">${reward != null ? `+${(reward * 100).toFixed(1)}%` : '–'} · Chỉ để tham khảo, không chốt lời theo mốc</span>
      </div>
    </div>

    <!-- 2. 3 TRỤ CỘT ĐÁNH GIÁ NHANH (3 PILLARS CHECKLIST) -->
    ${renderPillarsChecklist(a)}

    <!-- 3. QUẢN TRỊ VỐN & RỦI RO 1% NAV -->
    ${st ? capitalBox(a, st) : ''}

    <!-- 4. THẺ MỞ RỘNG CHI TIẾT (ẨN MẶC ĐỊNH CHO AI MUỐN SOI SÂU) -->
    <details class="bf-deep-details" open>
      <summary class="bf-deep-toggle">🔬 Thẩm định AI, bậc thang giá &amp; rủi ro chuyên sâu</summary>
      <div class="bf-deep-content">
        ${aiReviewBlock(a, eff)}
        ${mcAndRiskBlock(a)}
        ${st ? `<div class="bf-plays">
          <div class="bf-play${b.holding ? '' : ' mine'}">
            <h4>🆕 Nếu chưa có cổ phiếu${b.holding ? '' : ' <span class="bf-you">trường hợp của bạn</span>'}</h4>
            <div class="tbl-wrap">${table(st.fresh)}</div>
          </div>
          <div class="bf-play${b.holding ? ' mine' : ''}">
            <h4>💼 Nếu đang nắm giữ${b.holding ? ' <span class="bf-you">trường hợp của bạn</span>' : ''}</h4>
            ${b.plays?.position ? `<div class="bf-pos">${esc(b.plays.position)}</div>` : '<div class="muted small" style="margin-bottom:6px">Ghi lệnh trong 💼 Danh mục để tool tính đúng số cổ phiếu cần mua thêm / bán theo vị thế của bạn.</div>'}
            ${eff.fin?.holder ? holderBlock(eff.fin.holder) : ''}
            <div class="tbl-wrap">${table(st.hold)}</div>
          </div>
        </div>` : ''}
        <div class="bf-body">
          <ul class="bf-reasons">${b.reasons.map((r) => `<li data-tone="${r.tone}"><span class="bf-ic" aria-hidden="true">${BRIEF_ICON[r.tone]}</span>${esc(r.text)}</li>`).join('')}</ul>
          ${l ? ladder(l) : ''}
        </div>
        ${b.risks.length ? `<div class="bf-risks">⚠ ${b.risks.map(esc).join(' · ')}</div>` : ''}
      </div>
    </details>`;
}

function setCapital(v) {
  try { localStorage.setItem('vnstock_capital', String(Math.max(0, Number(v) || 0))); } catch { /* bỏ qua */ }
  if (state.current) renderBrief(state.current);
}
$('brief-card')?.addEventListener('change', (e) => {
  if (e.target.id === 'bf-capital') setCapital(e.target.value);
});
$('brief-card')?.addEventListener('keydown', (e) => {
  if (e.target.id === 'bf-capital' && e.key === 'Enter') setCapital(e.target.value);
});

$('brief-card')?.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-cap]');
  if (chip) { setCapital(chip.dataset.cap); return; }
  if (e.target.closest('[data-bf="rerun"]') && state.current) { runAiFor(state.current); return; }
  if (e.target.id !== 'bf-copy' || !state.current?.brief) return;
  try {
    await navigator.clipboard.writeText(briefText(state.current));
    showToast('Đã sao chép tóm tắt', 'success');
  } catch {
    showToast('Trình duyệt không cho phép sao chép', 'error');
  }
});

// ---------- Doanh nghiệp: KQKD theo quý, định giá, sự kiện, cổ đông, khuyến nghị CTCK ----------
const EARN_TONE = { TANG_TOC: 'up', ON_DINH: 'up', CHAM_LAI: 'ref', SUY_GIAM: 'down', CHUA_RO: 'ref' };
const EARN_LABEL = { TANG_TOC: 'Lợi nhuận tăng tốc', ON_DINH: 'Tăng trưởng ổn định', CHAM_LAI: 'Tăng trưởng chậm lại', SUY_GIAM: 'Lợi nhuận suy giảm', CHUA_RO: 'Chưa rõ' };
const VAL_TONE = { RE: 'up', HOP_LY: 'ref', DAT: 'down', CHUA_RO: 'ref' };
const VAL_LABEL = { RE: 'Rẻ so với lịch sử', HOP_LY: 'Định giá hợp lý', DAT: 'Đắt so với lịch sử', CHUA_RO: 'Chưa rõ' };
const tyB = (v) => (v == null ? '–' : fmt(v / 1e9, 0));
const pctB = (v) => (v == null ? '–' : `<span class="${dirClass(v)}">${signed(v * 100, 0)}%</span>`);

function valRange(x, name) {
  if (!x) return `<div class="biz-val"><b>${name}</b> <span class="muted small">không có dữ liệu</span></div>`;
  const pos = Math.round(x.percentile * 100);
  return `<div class="biz-val"><div><b>${name} ${fmt(x.current, 2)}</b> <span class="muted small">· trung vị 5 năm ${fmt(x.median, 2)} · thấp ${fmt(x.min, 2)} – cao ${fmt(x.max, 2)}</span></div>
    <div class="biz-range" title="Vị trí trong lịch sử: trái = rẻ nhất, phải = đắt nhất"><i style="left:${pos}%"></i></div>
    <div class="small ${pos <= 25 ? 'up' : pos >= 75 ? 'down' : 'muted'}">Đắt hơn ${pos}% số ngày trong lịch sử</div></div>`;
}

function renderBusiness(a) {
  const el = $('biz-card');
  const c = a.company;
  el.hidden = a.isIndex || !c;
  if (el.hidden) return;
  const ai = currentFlowAi(a) || (state.aiResult?.symbol === a.symbol ? state.aiResult : null);
  const bv = ai?.businessView;
  const e = c.earnings, v = c.valuation, ev = c.events;
  const maxP = e ? Math.max(...e.quarters.map((q) => Math.abs(q.profit || 0)), 1) : 1;
  const bars = e ? e.quarters.map((q) => {
    const h = Math.round((Math.abs(q.profit || 0) / maxP) * 100);
    const tone = q.profitYoY == null ? '' : q.profitYoY >= 0 ? 'pos' : 'neg';
    return `<div class="biz-bar" title="${q.label}: LN ${tyB(q.profit)} tỷ, so cùng kỳ ${q.profitYoY != null ? signed(q.profitYoY * 100, 0) + '%' : '–'}">
      <span class="small">${q.profitYoY != null ? signed(q.profitYoY * 100, 0) + '%' : ''}</span><i class="${tone}${(q.profit || 0) < 0 ? ' loss' : ''}" style="height:${Math.max(3, h)}%"></i><span class="muted small">${q.label.replace('/20', '/')}</span></div>`;
  }).join('') : '';
  const rows = e ? [...e.quarters].reverse().slice(0, 8).map((q) => `<tr><td>${q.label}</td><td>${tyB(q.revenue)}</td><td>${pctB(q.revenueYoY)}</td><td><b>${tyB(q.profit)}</b></td><td>${pctB(q.profitYoY)}</td>
    <td>${q.grossMargin != null ? fmt(q.grossMargin * 100, 1) + '%' : '–'}</td><td>${q.netMargin != null ? fmt(q.netMargin * 100, 1) + '%' : '–'}</td><td>${tyB(q.cfo)}</td></tr>`).join('') : '';
  const evRow = (x, cls = '') => `<li class="${cls}"><b>${x.date.split('-').reverse().join('/')}</b> · ${esc(x.label)}: ${esc(x.note)}${x.dilutive && x.upcoming ? ' <span class="tag ref">có thể điều chỉnh giá / pha loãng</span>' : ''}</li>`;
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:8px">
      <div><h3>🏢 Doanh nghiệp: kết quả kinh doanh, định giá, sự kiện</h3>
        <div class="muted small">Báo cáo tài chính theo quý (VNDirect)${e ? ` · quý gần nhất ${e.latest} · báo cáo ${e.nextReport.quarter} dự kiến trước ${e.nextReport.dueBy.split('-').reverse().join('/')}` : ''}</div></div>
      <div class="flow-head">
        ${e ? `<span class="st-badge ${EARN_TONE[bv?.earnings || e.trend]}">${esc(bv?.earningsLabel || EARN_LABEL[e.trend])}</span>` : ''}
        ${v ? `<span class="st-badge ${VAL_TONE[bv?.valuation || v.verdict]}">${esc(bv ? `Định giá ${bv.valuationLabel.toLowerCase()}` : VAL_LABEL[v.verdict])}</span>` : ''}
        <span class="muted small">${bv ? 'AI nhận định' : 'máy tính'}</span>
      </div>
    </div>
    ${bv ? `<div class="flow-ai">
      <div><b>📈 Kinh doanh:</b> ${esc(bv.earningsNote)}</div>
      <div><b>💲 Định giá:</b> ${esc(bv.valuationNote)}</div>
      <div><b>📅 Sự kiện:</b> ${esc(bv.eventImpact)}</div>
      <div class="flow-advice"><b>⏭ Mốc sắp tới:</b> ${esc(bv.nextCatalyst)}</div></div>` : ''}
    ${e ? `<div class="flow-stats">
      <div class="flow-stat"><span>LN quý gần nhất so cùng kỳ</span><b>${pctB(e.profitYoY)}</b></div>
      <div class="flow-stat"><span>Tốc độ so với quý trước</span><b class="${dirClass(e.accel)}">${e.accel != null ? signed(e.accel * 100, 0) + ' điểm %' : '–'}</b></div>
      <div class="flow-stat"><span>Chuỗi quý</span><b>${e.growthStreak ? `<span class="up">${e.growthStreak} quý tăng</span>` : e.declineStreak ? `<span class="down">${e.declineStreak} quý giảm</span>` : '–'}</b></div>
      <div class="flow-stat"><span>LN 4 quý</span><b>${tyB(e.profitTTM)} tỷ ${pctB(e.profitTTMGrowth)}</b></div>
      <div class="flow-stat"><span>ROE 4 quý</span><b>${e.roeTTM != null ? fmt(e.roeTTM * 100, 1) + '%' : '–'}</b></div>
      <div class="flow-stat" title="Dòng tiền kinh doanh / lợi nhuận 4 quý: < 0,5 là lợi nhuận chưa thu được tiền"><span>Dòng tiền KD / LN</span><b class="${e.cfoToProfit == null ? '' : e.cfoToProfit < 0.5 ? 'down' : 'up'}">${e.cfoToProfit ?? '<span class="muted small">không áp dụng</span>'}</b></div>
    </div>
    <div class="biz-bars">${bars}</div>
    <details class="biz-details"><summary>Bảng 8 quý (tỷ đồng)</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quý</th><th>${e.bank ? 'Tổng thu nhập HĐ' : 'Doanh thu'}</th><th>so cùng kỳ</th><th>LN sau thuế cty mẹ</th><th>so cùng kỳ</th><th>Biên gộp</th><th>Biên ròng</th><th>Dòng tiền KD</th></tr></thead><tbody>${rows}</tbody></table></div></details>` : '<p class="muted small">Chưa có báo cáo tài chính theo quý.</p>'}
    <div class="bt-grid" style="margin-top:10px">
      <div class="bt-block"><h4>💲 Định giá so với 5 năm và ngành</h4>
        ${v ? `${valRange(v.pe, 'P/E')}${valRange(v.pb, 'P/B')}
          ${v.sector ? `<div class="small">Trung vị ${v.sector.n} mã cùng ngành: P/E <b>${fmt(v.sector.pe, 1)}</b> · P/B <b>${fmt(v.sector.pb, 2)}</b> · ROE <b>${v.sector.roe != null ? fmt(v.sector.roe * 100, 1) + '%' : '–'}</b></div>` : ''}` : '<p class="muted small">Không có dữ liệu định giá.</p>'}
      </div>
      <div class="bt-block"><h4>📅 Sự kiện doanh nghiệp</h4>
        ${ev?.alerts.length ? `<ul class="biz-ev">${ev.alerts.map((x) => evRow(x, 'down')).join('')}</ul>` : ''}
        ${ev?.upcoming.length ? `<div class="small"><b>Sắp tới</b></div><ul class="biz-ev">${ev.upcoming.map((x) => evRow(x, 'biz-up')).join('')}</ul>` : '<div class="muted small">Không có sự kiện sắp tới đã công bố.</div>'}
        ${ev?.recent.length ? `<details class="biz-details"><summary>Đã diễn ra (12 tháng)</summary><ul class="biz-ev">${ev.recent.map((x) => evRow(x)).join('')}</ul></details>` : ''}
      </div>
    </div>
    <div class="bt-grid">
      <div class="bt-block"><h4>👥 Cổ đông lớn</h4>
        ${c.holders?.length ? `<ul class="biz-ev">${c.holders.slice(0, 6).map((h) => `<li>${esc(h.name)} <b>${fmt(h.pct, 2)}%</b> <span class="muted small">${esc(h.role || '')}</span></li>`).join('')}</ul><div class="muted small">Dữ liệu ngày ${c.holders[0].date}</div>` : '<p class="muted small">Không có dữ liệu.</p>'}
      </div>
      <div class="bt-block"><h4>🏦 Khuyến nghị công ty chứng khoán (12 tháng)</h4>
        ${c.brokers?.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>CTCK</th><th>Khuyến nghị</th><th>Kỳ vọng tăng</th></tr></thead><tbody>
          ${c.brokers.slice(0, 8).map((b) => `<tr><td>${b.date}</td><td>${esc(b.firm)}</td><td class="${/BUY|OUTPERFORM|ADD/i.test(b.type) ? 'up' : /SELL|UNDER|REDUCE/i.test(b.type) ? 'down' : ''}">${esc(b.type)}</td><td>${pctB(b.upside)}</td></tr>`).join('')}</tbody></table></div>
          <div class="muted small">% kỳ vọng tính tại ngày báo cáo (giá mục tiêu chưa điều chỉnh chia tách/cổ phiếu thưởng).</div>`
          : `<p class="muted small">Không có báo cáo trong 12 tháng${c.brokersOld ? ` (${c.brokersOld} báo cáo cũ hơn đã bỏ qua)` : ''}.</p>`}
      </div>
    </div>`;
}

// ---------- Phe mua / phe bán 10 phiên: gom hay xả ----------
const FLOW_TONE = { GOM: 'up', GOM_YEU: 'up', GIANG_CO: 'ref', XA_YEU: 'down', XA: 'down' };
const RULE_PHASE = { GOM: ['Gợi ý: đang gom', 'up'], XA: ['Gợi ý: đang xả', 'down'], GIANG_CO: ['Gợi ý: giằng co', 'ref'] };
const READ_LABEL = { GOM: ['Gom', 'up'], XA: ['Xả', 'down'], TRUNG_TINH: ['–', 'ref'] };
const kcpUi = (v) => (v == null ? '–' : v >= 1e6 ? `${fmt(v / 1e6, 2)} tr` : `${fmt(v / 1000, 0)}k`);
const tyUi = (v) => (v == null ? '–' : `<span class="${dirClass(v)}">${signed(v / 1e9, 1)}</span>`);

/** Phân tích gom/xả của AI cho mã đang xem: ưu tiên kết quả đã qua hội đồng, sau đó Gemini, cùng phiên giá. */
function currentFlowAi(a) {
  const g = state.cmResult?.symbol === a.symbol ? state.cmResult.gemini : null;
  const ai = g?.flowAnalysis ? g : state.aiResult?.symbol === a.symbol ? state.aiResult : null;
  return ai?.flowAnalysis && ai.priceDate === a.price.date ? ai : null;
}

function renderFlow(a) {
  const el = $('flow-card');
  const f = a.orderFlow;
  el.hidden = a.isIndex || !f;
  if (el.hidden) return;
  const ai = currentFlowAi(a);
  const fa = ai?.flowAnalysis;
  const aiRead = new Map((fa?.sessionReads || []).map((x) => [x.date, x]));
  const [ruleLabel, ruleTone] = RULE_PHASE[f.phase];
  setFold('sec-flow', fa ? `${fa.phaseLabel} (AI)` : ruleLabel, fa ? FLOW_TONE[fa.phase] : ruleTone);
  const verdict = fa
    ? `<span class="flow-verdict ${FLOW_TONE[fa.phase]}">${esc(fa.phaseLabel)}</span><span class="muted small">AI · rõ ràng ${fa.strength}/100</span>`
    : `<span class="flow-verdict ref">${state.aiRunning === a.symbol ? '<span class="mini-spin"></span> AI đang đọc phe mua/bán…' : 'AI chưa phân tích'}</span>`;
  const stat = (k, v) => `<div class="flow-stat"><span>${k}</span><b>${v}</b></div>`;
  const rows = [...f.sessions].reverse().map((d) => {
    const r = aiRead.get(d.date);
    const [lb, tone] = READ_LABEL[r?.read || d.read];
    const pos = Math.round(((d.clv ?? 0) + 1) * 50);
    const act = d.active ? `${kcpUi(d.active.buy)} / ${kcpUi(d.active.sell)} <span class="muted small">(${Math.round(d.active.buyRatio * 100)}% mua)</span>` : '<span class="muted small">chưa lưu</span>';
    return `<tr>
      <td>${d.date.slice(5).split('-').reverse().join('/')}</td>
      <td>${fmt(d.close)}</td><td class="${dirClass(d.chg)}">${signed(d.chg)}%</td>
      <td>${kcpUi(d.volume)} <span class="${d.volRatio >= 1.3 ? 'up' : d.volRatio < 0.8 ? 'muted' : ''} small">×${fmt(d.volRatio, 2)}</span></td>
      <td title="Vị trí giá đóng cửa trong biên độ phiên: trái = đáy, phải = đỉnh"><div class="clv-bar"><i style="left:${pos}%"></i></div></td>
      <td>${tyUi(d.foreignNet)}</td><td>${tyUi(d.propNet)}</td><td>${act}</td>
      <td><span class="st-badge ${tone}">${lb}</span> <span class="small muted">${esc(r?.note || d.why.join('; '))}</span></td></tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:8px">
      <div><h3>🔍 Phe mua – phe bán ${f.n} phiên: đang gom hay xả?</h3>
        <div class="muted small">${f.from.split('-').reverse().join('/')} → ${f.to.split('-').reverse().join('/')} · khối lượng, vị trí đóng cửa, khối ngoại, tự doanh, mua/bán chủ động</div></div>
      <div class="flow-head">${verdict}<span class="st-badge ${ruleTone}" title="Theo quy tắc đơn giản của hệ thống, AI có thể kết luận khác">${ruleLabel} (${signed(f.score, 1)})</span></div>
    </div>
    <div class="flow-stats">
      ${stat('Giá ' + f.n + ' phiên', `<span class="${dirClass(f.priceChg)}">${signed(f.priceChg)}%</span>`)}
      ${stat('KL phiên tăng / phiên giảm', `<span class="${f.upDownVolRatio >= 1.2 ? 'up' : f.upDownVolRatio < 0.8 ? 'down' : ''}">${fmt(f.upDownVolRatio, 2)} lần</span>`)}
      ${stat('Tích lũy / phân phối', `<span class="${dirClass(f.adLine)}">${signed(f.adLine, 2)}</span>`)}
      ${stat('Khối ngoại ròng', `${tyUi(f.foreignNet)} tỷ`)}
      ${stat('Tự doanh ròng', `${tyUi(f.propNet)} tỷ`)}
      ${stat('Mua / bán chủ động', f.activeDays ? `${kcpUi(f.activeBuy)} / ${kcpUi(f.activeSell)} <span class="muted small">(${f.activeDays} phiên)</span>` : '<span class="muted small">đang tích lũy dữ liệu</span>')}
    </div>
    ${fa ? `<div class="flow-ai">
      <div class="flow-advice"><b>💡 Lời khuyên:</b> ${esc(fa.advice)}</div>
      ${fa.adviceHolders ? `<div><b>Nếu đang nắm giữ:</b> ${esc(fa.adviceHolders)}</div>` : ''}
      <div class="flow-who"><div><b class="up">Bên mua:</b> ${esc(fa.whoBuys)}</div><div><b class="down">Bên bán:</b> ${esc(fa.whoSells)}</div></div>
      ${fa.evidence.length ? `<ul>${fa.evidence.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${fa.keySessions ? `<div><b>Phiên then chốt:</b> ${esc(fa.keySessions)}</div>` : ''}
      ${fa.confirmSignal ? `<div><b>👁 Tín hiệu xác nhận:</b> ${esc(fa.confirmSignal)}</div>` : ''}
    </div>` : ''}
    <div class="tbl-wrap"><table class="tbl flow-table"><thead><tr><th>Ngày</th><th>Giá</th><th>%</th><th>Khối lượng (×TB20)</th><th>Đóng cửa</th><th>NN ròng (tỷ)</th><th>Tự doanh (tỷ)</th><th>Mua / bán chủ động</th><th>Đọc phiên${fa ? ' (AI)' : ''}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted small" style="margin:6px 0 0">Mua/bán chủ động chỉ lấy được của phiên gần nhất; tool tự lưu mỗi ngày sau 15:10 cho các mã theo dõi, danh mục và cổ phiếu tiềm năng (và mỗi khi mở mã), nên cột này đầy dần theo thời gian. Lệnh lớn = lệnh khớp ≥ 500 triệu đồng.</p>`;
}

// ---------- Dòng tiền theo nhóm ngành ----------
const SC = { period: 1, sort: 'net', data: null, open: new Set() };
const tỷ = (v) => (v == null ? '–' : `${signed(v / 1e9, Math.abs(v) >= 1e11 ? 0 : 1)} tỷ`);

function showSectors() {
  ['marketview', 'empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'rankview', 'autoview'].forEach((id) => ($(id).hidden = true));
  $('auto-btn')?.classList.remove('on');
  markMobileView('analyze', 'more');
  ['picks-btn', 'pf-btn', 'rank-btn'].forEach((id) => $(id)?.classList.remove('on'));
  $('sectorview').hidden = false;
  $('sector-btn')?.classList.add('on');
  history.replaceState(null, '', '#nganh');
  loadSectors();
}

async function loadSectors() {
  if (!SC.data) {
    try {
      const cached = sessionStorage.getItem(`last_sectors_${SC.period}`);
      if (cached) {
        SC.data = JSON.parse(cached);
        renderSectors();
      }
    } catch {}
    if (!SC.data) {
      $('sc-list').innerHTML = '<p class="muted">Đang tải dòng tiền theo ngành…</p>';
    }
  }
  try {
    SC.data = await api(`/api/sectors?period=${SC.period}`);
    SC.period = SC.data.period; // máy chủ có thể giới hạn lại số phiên
    try { sessionStorage.setItem(`last_sectors_${SC.period}`, JSON.stringify(SC.data)); } catch {}
    renderSectors();
  } catch (err) {
    if (!SC.data) $('sc-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

const scValue = (s) => (SC.sort === 'foreign' ? (s.foreignNet ?? 0) : s.net);
const periodLabel = () => (SC.period === 1 ? 'phiên gần nhất' : `${SC.period} phiên`);

function renderSectors() {
  const d = SC.data;
  if (!d) return;
  const sectors = [...d.sectors].sort((a, b) => scValue(b) - scValue(a));
  const max = Math.max(...sectors.map((s) => Math.abs(scValue(s))), 1);
  const label = SC.sort === 'foreign' ? 'Khối ngoại ròng' : 'Dòng tiền ròng';
  $('sc-sub').textContent = `${periodLabel()} đến ${d.date} · ${d.universe} mã · ${d.sectors.length} ngành · tổng GTGD ${tỷ(d.market.value).replace('+', '')} · dòng tiền ròng ${tỷ(d.market.net)} · khối ngoại ${tỷ(d.market.foreignNet)}`;

  // Cổ phiếu dẫn dắt theo chiều đang xem (mua/bán), ưu tiên theo cột đang xếp
  const leaders = (s, dir) => {
    const key = SC.sort === 'foreign' ? 'foreignNet' : 'net';
    return [...s.stocks].filter((x) => (x[key] ?? 0) * dir > 0).sort((a, b) => dir * ((b[key] ?? 0) - (a[key] ?? 0))).slice(0, 3);
  };
  const side = (list, dir) => list.map((s, idx) => `
    <div class="sc-item" data-sector="${esc(s.name)}">
      <div class="sc-item-head">
        <div class="sc-item-title"><span class="sc-rank-badge ${dir > 0 ? 'pos' : 'neg'}">#${idx + 1}</span><b>${esc(s.name)}</b></div>
        <span class="${dirClass(scValue(s))} sc-item-val">${tỷ(scValue(s))}</span>
      </div>
      <div class="sc-item-sub">
        <span class="sc-stat-pill">Giá ${pct(s.ret)}</span>
        <span class="sc-stat-pill">GTGD ${tỷ(s.value).replace('+', '')}</span>
        <span class="sc-stat-pill ${s.valueRatio > 1.2 ? 'high' : ''}">${s.valueRatio != null ? `${fmt(s.valueRatio, 2)}× TB` : '–'}</span>
        <span class="sc-count-pill">${s.up}↑ ${s.down}↓</span>
      </div>
      <div class="sc-chips">${leaders(s, dir).map((x) => `<button type="button" class="sc-chip" data-sym="${x.symbol}" title="${label}: ${tỷ(SC.sort === 'foreign' ? x.foreignNet : x.net)} · giá ${pct(x.ret)}"><span class="sc-chip-sym">${x.symbol}</span> <span class="${dirClass(x.ret)} sc-chip-ret">${pct(x.ret)}</span></button>`).join('') || '<span class="muted small">–</span>'}</div>
    </div>`).join('');
  $('sc-top-in').innerHTML = side(sectors.filter((s) => scValue(s) > 0).slice(0, 5), 1) || '<p class="muted" style="padding:16px;text-align:center">Không có ngành nào có dòng tiền vào ròng.</p>';
  $('sc-top-out').innerHTML = side([...sectors].reverse().filter((s) => scValue(s) < 0).slice(0, 5), -1) || '<p class="muted" style="padding:16px;text-align:center">Không có ngành nào bị bán ròng.</p>';

  $('sc-list').innerHTML = `
    <div class="sc-table-wrap">
      <div class="sc-row sc-head">
        <span class="sc-col-name">Nhóm Ngành</span>
        <span class="sc-col-bar">
          <span class="sc-axis-label">
            <span>◀ BÁN RÒNG</span>
            <span class="sc-axis-center">0</span>
            <span>MUA RÒNG ▶</span>
          </span>
        </span>
        <span class="sc-col-val">${label}</span>
        <span class="sc-col-ret">Biến Động</span>
        <span class="sc-col-ratio">GTGD/TB</span>
        <span class="sc-col-other">${SC.sort === 'foreign' ? 'Dòng tiền' : 'Khối ngoại'}</span>
      </div>
      <div class="sc-body">
        ${sectors.map((s) => {
          const v = scValue(s), w = Math.min(50, (Math.abs(v) / max) * 50);
          const other = SC.sort === 'foreign' ? s.net : s.foreignNet;
          const open = SC.open.has(s.name);
          return `
          <div class="sc-row${open ? ' open' : ''}" data-sector="${esc(s.name)}" role="button" tabindex="0" aria-expanded="${open}"
            title="${esc(s.name)} · ${label}: ${tỷ(v)} · GTGD ${tỷ(s.value).replace('+', '')} (${fmt(s.share * 100, 1)}% thị trường) · ${s.count} mã: ${s.up} tăng, ${s.down} giảm">
            <span class="sc-col-name">
              <span class="sc-toggle-icon">${open ? '▼' : '▶'}</span>
              <span class="sc-name-text">${esc(s.name)}</span>
              <span class="sc-badge-count">${s.count}</span>
            </span>
            <span class="sc-col-bar" aria-hidden="true">
              <span class="sc-track">
                <i class="sc-center-line"></i>
                <i class="sc-bar-fill ${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : `right:50%`};width:${w}%"></i>
              </span>
            </span>
            <span class="sc-col-val ${dirClass(v)}"><b>${tỷ(v)}</b></span>
            <span class="sc-col-ret ${dirClass(s.ret)}"><span class="badge-pill ${dirClass(s.ret)}">${pct(s.ret)}</span></span>
            <span class="sc-col-ratio"><span class="ratio-pill ${s.valueRatio > 1.2 ? 'high' : s.valueRatio < 0.8 ? 'low' : ''}">${s.valueRatio != null ? `${fmt(s.valueRatio, 2)}×` : '–'}</span></span>
            <span class="sc-col-other ${dirClass(other)}">${tỷ(other)}</span>
          </div>
          ${open ? sectorStocks(s) : ''}`;
        }).join('')}
      </div>
    </div>`;
}

function sectorStocks(s) {
  return `<div class="sc-detail">
    <div class="tbl-wrap">
      <table class="tbl sc-detail-table">
        <thead>
          <tr>
            <th>Mã CP</th>
            <th>Giá Đóng Cửa</th>
            <th>${SC.period === 1 ? 'Hôm Nay' : `${SC.period} Phiên`}</th>
            <th>GTGD</th>
            <th>So TB 20P</th>
            <th>Dòng Tiền Ròng</th>
            <th>Khối Ngoại Ròng</th>
            <th>Xếp Hạng</th>
          </tr>
        </thead>
        <tbody>
          ${s.stocks.map((x) => `
            <tr>
              <td><a href="#${x.symbol}" class="pf-sym sc-stock-link" data-sym="${x.symbol}"><b>${x.symbol}</b></a></td>
              <td><b>${fmt(x.close)}</b></td>
              <td><span class="badge-pill ${dirClass(x.ret)}">${pct(x.ret)}</span></td>
              <td>${tỷ(x.value).replace('+', '')}</td>
              <td><span class="ratio-pill ${x.valueRatio > 1.2 ? 'high' : x.valueRatio < 0.8 ? 'low' : ''}">${x.valueRatio != null ? `${fmt(x.valueRatio, 2)}×` : '–'}</span></td>
              <td class="${dirClass(x.net)}"><b>${tỷ(x.net)}</b></td>
              <td class="${dirClass(x.foreignNet)}"><b>${tỷ(x.foreignNet)}</b></td>
              <td><span class="rank-tag ${RANK_TONE[x.rankCode] || ''}">${x.rank ?? '–'}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function setSectorPeriod(n) {
  SC.period = Math.min(60, Math.max(1, Math.round(n) || 1));
  // Sáng nút có sẵn nếu trùng, ô nhập luôn hiện số phiên đang xem
  document.querySelectorAll('#sc-period button').forEach((x) => x.classList.toggle('on', Number(x.dataset.p) === SC.period));
  $('sc-custom').n.value = SC.period;
  loadSectors();
}
$('sc-period')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setSectorPeriod(Number(b.dataset.p));
});
$('sc-custom')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number(e.target.n.value);
  if (!(n >= 1 && n <= 60)) return showToast('Số phiên phải từ 1 đến 60', 'error');
  setSectorPeriod(n);
});
$('sc-sort')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  SC.sort = b.dataset.s;
  document.querySelectorAll('#sc-sort button').forEach((x) => x.classList.toggle('on', x === b));
  renderSectors();
});
$('sectorview')?.addEventListener('click', (e) => {
  const sym = e.target.closest('[data-sym]');
  if (sym) { e.preventDefault(); analyze(sym.dataset.sym); return; }
  const row = e.target.closest('[data-sector]');
  if (!row) return;
  const name = row.dataset.sector;
  if (SC.open.has(name)) SC.open.delete(name); else SC.open.add(name);
  renderSectors();
  if (row.classList.contains('sc-item')) document.querySelector(`.sc-row[data-sector="${CSS.escape(name)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('sectorview')?.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sc-row')) { e.preventDefault(); e.target.click(); }
});
$('sector-btn')?.addEventListener('click', showSectors);

// ---------- Khởi động ứng dụng ----------
initTheme();
loadMarket();
loadMarketRegime();
loadWatchlist();
loadAlerts();
loadMovers();

api('/api/ai/status').catch(() => ({ enabled: false })).then((s) => {
  state.ai = s;
  const initial = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  // Khởi động view theo hash hoặc mặc định
  if (initial === 'theo-doi' || initial === 'watchlist') {
    setMobileTab('watchlist');
  } else if (initial === 'thi-truong' || initial === 'market') {
    showMarket();
  } else if (initial === 'tiem-nang' || initial === 'picks') {
    setMobileTab('picks');
    showPicks();
  } else if (initial === 'danh-muc') {
    showPortfolio();
  } else if (initial === 'xep-hang') {
    showRankView();
  } else if (initial === 'nganh') {
    showSectors();
  } else if (initial === 'tu-dau-tu') {
    showAutoTrade();
  } else if (/^[A-Za-z0-9]{3,8}$/.test(initial) && !['watchlist', 'market', 'picks', 'danh-muc', 'xep-hang', 'nganh', 'tu-dau-tu', 'thi-truong'].includes(initial)) {
    analyze(initial.toUpperCase());
  } else {
    showMarket();
  }
});

// Lắng nghe thay đổi hash để điều hướng SPA mượt mà
window.addEventListener('hashchange', () => {
  const h = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  if (!h) return;
  if (h === 'thi-truong') {
    showMarket();
  } else if (h === 'tiem-nang' || h === 'picks') {
    setMobileTab('picks');
    showPicks();
  } else if (h === 'danh-muc') {
    showPortfolio();
  } else if (h === 'xep-hang') {
    showRankView();
  } else if (h === 'nganh') {
    showSectors();
  } else if (h === 'tu-dau-tu') {
    showAutoTrade();
  } else if (/^[A-Za-z0-9]{3,8}$/.test(h)) {
    analyze(h.toUpperCase());
  }
});

// ---------- Thị trường hôm nay: tổng quan đọc trong một phút ----------
const MK = { chart: null };
const MK_TONE = { CONFIRMED_UPTREND: 'up', UPTREND_UNDER_PRESSURE: 'ref', MARKET_CORRECTION: 'down', UNKNOWN: 'ref' };
const MK_TREND = { TANG: ['📈 Tăng', 'up'], TANG_NHE: ['↗ Tăng nhẹ', 'up'], DI_NGANG: ['➡ Đi ngang', 'ref'], GIAM_NHE: ['↘ Giảm nhẹ', 'down'], GIAM: ['📉 Giảm', 'down'] };
const ty = (v) => `${signed(v / 1e9, 0)} tỷ`;

function showMarket() {
  ['empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'rankview', 'sectorview', 'autoview'].forEach((id) => ($(id).hidden = true));
  ['picks-btn', 'pf-btn', 'rank-btn', 'sector-btn', 'auto-btn'].forEach((id) => $(id)?.classList.remove('on'));
  markMobileView('picks', 'market');
  $('marketview').hidden = false;
  history.replaceState(null, '', '#thi-truong');
  loadMarketPage();
}

async function loadMarketPage() {
  const body = $('mk-body');
  if (!body.dataset.loaded) body.innerHTML = '<div class="loading-state" style="border:none;padding:40px"><span>Đang tổng hợp thị trường…</span></div>';
  const [m, reg, mv, sec, out, scr, chart] = await Promise.all([
    api('/api/market').catch(() => null), api('/api/market-regime').catch(() => null), api('/api/movers').catch(() => null),
    api('/api/sectors?period=1').catch(() => null), api('/api/outlook').catch(() => null), api('/api/screener').catch(() => null),
    api('/api/chart/VNINDEX?tf=D').catch(() => null),
  ]);
  if ($('marketview').hidden) return;
  body.dataset.loaded = '1';
  renderMarketPage({ m, reg, mv, sec, out, ai: scr?.result?.ai && !scr.result.ai.error ? scr.result.ai : null, aiDate: scr?.result?.date, chart });
}

function renderMarketPage({ m, reg, mv, sec, out, ai, aiDate, chart }) {
  const br = reg?.breadth?.pctAboveMa50;
  const tone = MK_TONE[reg?.regime] || 'ref';
  const buyOk = reg?.allowNewBuys && (br == null || br >= 50);
  const date = (m?.date || mv?.date || '').split('-').reverse().join('/');
  $('mk-sub').textContent = date ? `Phiên ${date} · HOSE` : '';

  // Lý do: tối đa 4 dòng, mỗi dòng một sự thật đo được
  const why = [];
  if (reg) {
    const pos = [reg.aboveMa50 ? 'trên' : 'dưới', reg.aboveMa200 ? 'trên' : 'dưới'];
    why.push([reg.aboveMa50 && reg.aboveMa200 ? 'up' : !reg.aboveMa50 && !reg.aboveMa200 ? 'down' : 'ref', `VN-Index ${pos[0]} MA50, ${pos[1]} MA200${reg.from1yHighPct != null ? ` · cách đỉnh 1 năm ${signed(reg.from1yHighPct, 1)}%` : ''}`]);
    if (reg.distDays != null) why.push([reg.distDays >= 5 ? 'down' : 'up', `${reg.distDays} phiên phân phối (giảm kèm thanh khoản lớn) gần đây${reg.distDays >= 5 ? ': áp lực bán mạnh' : ''}`]);
  }
  if (br != null) why.push([br >= 50 ? 'up' : 'down', `${Math.round(br)}% cổ phiếu trên MA50${br < 50 ? ': số mã khỏe ít, luật đã kiểm định là không mua mới' : ''}`]);
  if (mv?.foreignTotal) why.push([dirClass(mv.foreignTotal.netVal), `Khối ngoại ${mv.foreignTotal.netVal >= 0 ? 'mua' : 'bán'} ròng ${fmt(Math.abs(mv.foreignTotal.netVal) / 1e9, 0)} tỷ trong phiên`]);

  const b = mv?.breadth;
  const tile = (k, v, s, cls = '') => `<div class="qc-tile ${cls}"><span class="k">${k}</span><b class="v">${v}</b><span class="s">${s}</span></div>`;
  const list = (title, rows, fmtRow) => `<div class="mk-list"><h4>${title}</h4>${rows?.length ? `<ol>${rows.slice(0, 5).map(fmtRow).join('')}</ol>` : '<p class="muted small">Chưa có số liệu</p>'}</div>`;
  const symLink = (s) => `<a href="#${esc(s)}" class="pf-sym" data-sym="${esc(s)}"><b>${esc(s)}</b></a>`;
  const stockRow = (x) => `<li>${symLink(x.symbol)}<span class="num">${fmt(x.close)}</span><span class="num ${dirClass(x.changePct)}">${signed(x.changePct, 1)}%</span></li>`;
  const flowRow = (x) => `<li>${symLink(x.symbol)}<span></span><span class="num ${dirClass(x.netVal)}">${ty(x.netVal)}</span></li>`;
  const secs = (sec?.sectors || []).filter((s) => s.net != null);
  const secIn = [...secs].sort((x, y) => y.net - x.net).filter((s) => s.net > 0);
  const secOut = [...secs].sort((x, y) => x.net - y.net).filter((s) => s.net < 0);
  const secRow = (s) => `<li><span class="mk-sec">${esc(s.name)}</span><span class="num ${dirClass(s.ret)}">${signed((s.ret || 0) * 100, 1)}%</span><span class="num ${dirClass(s.net)}">${ty(s.net)}</span></li>`;
  const o = out?.result, [tLabel, tTone] = MK_TREND[o?.trend] || ['–', 'ref'];

  $('mk-body').innerHTML = `
    <section class="card quick-card">
      <div class="qc-verdict-row">
        <div class="qc-verdict ${tone}">${{ up: '▲', down: '▼', ref: '•' }[tone]} ${esc(reg?.label || 'Chưa xác định')}</div>
        <p class="qc-action">${buyOk ? `Được mua mới theo xếp hạng. Tỷ trọng cổ phiếu nên ở mức ${esc(reg.exposure)}.` : `Không mua mới. Giữ cổ phiếu ở mức ${esc(reg?.exposure || '0–20%')}, còn lại để tiền mặt; mã đang giữ theo luật giữ / bán.`}</p>
      </div>
      <div class="qc-tiles">
        ${m ? tile('VN-Index', fmt(m.close), `<span class="${dirClass(m.change)}">${signed(m.change, 1)} (${signed(m.changePct)}%)</span> · 20 phiên ${signed(m.return20d, 1)}%`, dirClass(m.change)) : ''}
        ${br != null ? tile('Mã khỏe (trên MA50)', `${Math.round(br)}%`, br >= 50 ? 'Đủ rộng để mua' : 'Dưới 50%: yếu', br >= 50 ? 'up' : 'down') : ''}
        ${b ? tile('Tăng / giảm', `<span class="up">${b.advancers}</span> / <span class="down">${b.decliners}</span>`, `${b.unchanged} mã đứng giá`, b.advancers >= b.decliners ? 'up' : 'down') : ''}
        ${mv?.foreignTotal ? tile('Khối ngoại', ty(mv.foreignTotal.netVal), `mua ${fmt(mv.foreignTotal.buyVal / 1e9, 0)} · bán ${fmt(mv.foreignTotal.sellVal / 1e9, 0)} tỷ`, dirClass(mv.foreignTotal.netVal)) : ''}
        ${b?.totalValue ? tile('Giá trị khớp', `${fmt(b.totalValue / 1e9, 0)} tỷ`, 'toàn sàn HOSE') : ''}
      </div>
      ${why.length ? `<ul class="qc-why">${why.map(([t, x]) => `<li class="${t === 'up' ? 'up' : t === 'down' ? 'down' : ''}"><span aria-hidden="true">${t === 'up' ? '▲' : t === 'down' ? '▼' : '•'}</span>${esc(x)}</li>`).join('')}</ul>` : ''}
    </section>

    <div class="mk-grid">
      <section class="card mk-chart-card">
        <div class="card-head"><div><h3>VN-Index 1 năm</h3><div class="muted small">Đường giá đóng cửa, MA50 và MA200</div></div></div>
        <div id="mk-chart" class="mk-chart"></div>
      </section>
      <section class="card mk-ai">
        <div class="card-head"><div><h3>✦ Nhận định của AI</h3><div class="muted small">${o ? `Tuần ${out.week.monday.split('-').reverse().join('/')} – ${out.week.friday.split('-').reverse().join('/')}` : ''}</div></div>
          ${o ? `<span class="st-badge ${tTone}">${tLabel}</span>` : ''}</div>
        ${o ? `<p class="mk-ai-text">${esc(o.summary)}</p>
          <div class="mk-ai-line"><span class="muted">Biên độ dự kiến</span><b>${fmt(o.low, 0)} – ${fmt(o.high, 0)}</b></div>
          ${o.strategy ? `<div class="mk-ai-line"><span class="muted">Chiến lược</span><span>${esc(o.strategy)}</span></div>` : ''}` : '<p class="muted small">Chưa có nhận định tuần (tạo sau phiên chiều thứ 6).</p>'}
        ${ai?.marketView ? `<div class="mk-ai-day"><b>Hôm nay${aiDate ? ` (${aiDate.split('-').reverse().join('/')})` : ''}:</b> ${esc(ai.marketView)}</div>` : ''}
      </section>
    </div>

    <section class="card">
      <div class="card-head"><div><h3>Dòng tiền ngành hôm nay</h3><div class="muted small">Ước tính từ giá trị khớp phiên tăng / giảm · bấm Ngành để xem chi tiết</div></div></div>
      <div class="mk-lists two">
        ${list('🟢 Hút tiền mạnh nhất', secIn, secRow)}
        ${list('🔴 Bị bán mạnh nhất', secOut, secRow)}
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Cổ phiếu nổi bật</h3><div class="muted small">HOSE, giá trị khớp ≥ 5 tỷ · bấm mã để phân tích</div></div></div>
      <div class="mk-lists">
        ${list('Tăng mạnh', mv?.gainers, stockRow)}
        ${list('Giảm mạnh', mv?.losers, stockRow)}
        ${list('Khối ngoại mua ròng', mv?.foreignBuy, flowRow)}
        ${list('Khối ngoại bán ròng', mv?.foreignSell, flowRow)}
      </div>
    </section>`;
  drawMarketChart(chart);
}

function drawMarketChart(data) {
  const el = $('mk-chart');
  if (MK.chart) { MK.chart.remove(); MK.chart = null; }
  if (!el || !data?.bars?.length || !window.LightweightCharts) return;
  const LC = window.LightweightCharts;
  const from = data.bars.at(-250)?.time || data.bars[0].time;
  const cut = (pts) => pts.filter((p) => p.time >= from);
  const chart = LC.createChart(el, {
    autoSize: true, ...CHART_TOUCH,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    localization: { locale: 'vi-VN', priceFormatter: (v) => fmt(v, 0) },
    handleScale: false, handleScroll: false,
  });
  const line = (color, w = 1.5) => chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const last = data.bars.at(-1), first = data.bars.find((b) => b.time >= from);
  const area = chart.addAreaSeries({
    lineColor: last.close >= first.close ? css('--up') : css('--down'), lineWidth: 2,
    topColor: withAlpha(last.close >= first.close ? css('--up') : css('--down'), 0.18), bottomColor: withAlpha(css('--surface'), 0),
    priceLineVisible: false,
  });
  area.setData(cut(data.bars.map((b) => ({ time: b.time, value: b.close }))));
  line(css('--s2')).setData(cut(data.sma50));
  line(css('--s3')).setData(cut(data.sma200));
  chart.timeScale().fitContent();
  MK.chart = chart;
}

$('mk-btn')?.addEventListener('click', showMarket);
$('mk-refresh')?.addEventListener('click', loadMarketPage);
$('mk-body')?.addEventListener('click', (e) => {
  const a = e.target.closest('[data-sym]');
  if (!a) return;
  e.preventDefault();
  analyze(a.dataset.sym);
});

// ---------- Tool tự đầu tư (tài khoản giấy) ----------
const AT_REASON = { hold_end: 'Hết 40 phiên, không còn là ứng viên', delisted: 'Ngừng giao dịch' };
const vnd = (v) => (v == null ? '–' : `${Math.round(v).toLocaleString('vi-VN')} đ`);

function showAutoTrade() {
  ['marketview', 'empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'rankview', 'sectorview'].forEach((id) => ($(id).hidden = true));
  ['picks-btn', 'pf-btn', 'rank-btn', 'sector-btn'].forEach((id) => $(id)?.classList.remove('on'));
  markMobileView('analyze', 'more');
  $('auto-btn')?.classList.add('on');
  $('autoview').hidden = false;
  history.replaceState(null, '', '#tu-dau-tu');
  loadAutoTrade();
}

async function loadAutoTrade(action = null) {
  $('at-summary').innerHTML = '<div class="muted small">Đang tải…</div>';
  try {
    const d = action ? await api(`/api/autotrade/${action}`, { method: 'POST' }) : await api('/api/autotrade');
    renderAutoTrade(d);
    loadScorecard();
  } catch (err) {
    $('at-summary').innerHTML = `<p class="down">${esc(err.message)}</p>`;
  }
}

// ---------- Bảng chấm điểm tuần ----------
async function loadScorecard() {
  const el = $('at-score');
  try {
    const sc = await api('/api/scorecard');
    if ($('autoview').hidden) return;
    el.innerHTML = renderScorecard(sc);
    el.hidden = false;
  } catch (err) {
    el.innerHTML = `<p class="down small">Không tính được bảng chấm điểm: ${esc(err.message)}</p>`;
    el.hidden = false;
  }
}

function renderScorecard(sc) {
  const p = (v, d = 1) => (v == null ? '–' : `${signed(v * 100, d)}%`);
  const t = sc.tool;
  const dm = (s) => s.split('-').reverse().slice(0, 2).join('/');
  const tile = (k, v, s, cls = '') => `<div class="qc-tile ${cls}"><span class="k">${k}</span><b class="v">${v}</b><span class="s">${s}</span></div>`;
  const side = (x, buy) => (x.n
    ? `<b>${x.right}/${x.n}</b> đúng <span class="muted">(${Math.round((x.right / x.n) * 100)}%)</span>${buy && x.avgExcess != null ? ` · TB <span class="${dirClass(x.avgExcess)}">${p(x.avgExcess)}</span> so rổ` : ''}${buy && x.worst.length ? `<div class="muted small">sai nhiều nhất: ${x.worst.map(esc).join(', ')}</div>` : ''}`
    : '<span class="muted">không có</span>');
  return `
    <div class="card-head"><div><h3>🏆 Bảng chấm điểm tuần ${dm(sc.week.from)} – ${dm(sc.week.to)}</h3>
      <div class="muted small">Thước đo duy nhất không tự lừa được: tool có thắng VN-Index bằng tiền thật (giấy) không, và khuyến nghị đúng bao nhiêu.</div></div></div>
    <p class="sc-verdict ${t?.week.vs != null ? dirClass(t.week.vs) : ''}">${esc(sc.verdict)}</p>
    ${t ? `<div class="qc-tiles">
      ${tile('Tool tuần này', p(t.week.ret), `VN-Index ${p(t.week.index)}`, dirClass(t.week.vs))}
      ${tile('Từ khi bắt đầu', p(t.total.ret), `VN-Index ${p(t.total.index)} · ${t.sessions} phiên`, dirClass(t.total.vs))}
      ${tile('Sụt lớn nhất', p(t.maxDrawdown), 'từ đỉnh tài sản', t.maxDrawdown < -0.1 ? 'down' : '')}
      ${tile('Lệnh trong tuần', `${t.trades.buys} mua · ${t.trades.sells} bán`, t.trades.sells ? `${t.trades.wins} lệnh bán có lãi` : 'chưa có lệnh bán', '')}
    </div>` : ''}
    ${sc.calls.length ? `<div class="tbl-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>Khuyến nghị đủ ${sc.horizon} phiên trong tuần</th><th>Mua (đúng = hơn rổ)</th><th>Tránh (đúng = kém rổ)</th></tr></thead><tbody>
      ${sc.calls.map((c) => `<tr><td>${esc(c.label)}</td><td>${side(c.buy, true)}</td><td>${side(c.avoid, false)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted small" style="margin-top:10px">Chưa có khuyến nghị nào đủ 5 phiên kết thúc trong tuần này.</p>'}`;
}

function renderAutoTrade(d) {
  if (!d.opened) {
    $('at-actions').innerHTML = '';
    $('at-summary').innerHTML = `
      <div class="pk-none">
        <p>Tool sẽ dùng đúng <b>vốn thực nạp ròng</b> của bạn${d.netContributed ? ` (<b>${vnd(d.netContributed)}</b>)` : ''} để tự chọn mã và tự mua bán, giống hệt quy trình bạn đang xem trong các khuyến nghị:</p>
        <ul class="pk-none-list">
          <li>Chọn mã điểm xếp hạng ≥ 70 và trên MA200, hoặc mã xu hướng chuẩn; tối đa ${d.rules.slots} mã, mỗi ngành ${d.rules.perSector} mã</li>
          ${d.rules.maxExposure < 1 ? `<li>Luôn giữ ít nhất ${Math.round((1 - d.rules.maxExposure) * 100)}% tiền mặt dự phòng: cổ phiếu tối đa ${Math.round(d.rules.maxExposure * 100)}% tài sản, mỗi mã khoảng ${Math.round((d.rules.maxExposure / d.rules.slots) * 100)}%</li>` : ''}
          <li>Quyết định sau giờ đóng cửa (từ 15:10), khớp ở giá mở cửa phiên sau; ${d.rules.step > 1 ? `xét lại mỗi ${d.rules.step} phiên` : `xét lại mỗi phiên nhưng mua rải dần, mỗi phiên tối đa ${d.rules.maxNew} mã`}, giữ ${d.rules.hold} phiên</li>
          <li>Tính phí, thuế, T+2, kẹt trần/sàn; mua lô lẻ vì vốn nhỏ; vốn tự tăng/giảm theo vốn thực nạp ròng</li>
        </ul>
        <p class="muted small">Đây là tài khoản giấy để kiểm chứng tool có kiếm được lợi nhuận thật hay không: không đặt lệnh thật, không phải lời khuyên đầu tư. Cần ít nhất 6–12 tháng mới đủ để đánh giá.</p>
        ${d.netContributed ? '<div class="picks-actions"><button type="button" class="btn btn-primary" id="at-open">Bắt đầu tự đầu tư</button></div>' : '<p class="down">Chưa có vốn thực nạp ròng: hãy nạp tiền ở trang Danh mục trước.</p>'}
      </div>`;
    $('at-body').innerHTML = '';
    return;
  }
  $('at-actions').innerHTML = `
    <button type="button" class="btn btn-secondary btn-sm" id="at-run" title="Xử lý ngay phiên đã chốt (bình thường tự chạy sau 15:10)">↻ Cập nhật</button>
    <button type="button" class="btn btn-ghost btn-sm" id="at-reset">Đặt lại</button>`;
  const cls = dirClass(d.pnl);
  const vsIndex = d.pnlPct != null && d.indexPct != null ? d.pnlPct - d.indexPct : null;
  $('at-summary').innerHTML = `
    <div class="cap-stat-grid">
      <div class="cap-stat-item primary"><div class="cap-stat-label">Tổng tài sản (NAV)</div><div class="cap-stat-val">${vnd(d.nav)}</div><div class="cap-stat-sub">Tiền mặt ${vnd(d.cash)} · cổ phiếu ${vnd(d.stock)}${d.rules.maxExposure < 1 ? ` · giữ dự phòng ≥ ${Math.round((1 - d.rules.maxExposure) * 100)}%` : ''}</div></div>
      <div class="cap-stat-item ${cls}"><div class="cap-stat-label">Lãi / lỗ so với vốn</div><div class="cap-stat-val ${cls}">${d.pnl >= 0 ? '+' : ''}${vnd(d.pnl)}</div><div class="cap-stat-sub ${cls}">${signed(d.pnlPct)}% trên vốn ${vnd(d.funded)}</div></div>
      <div class="cap-stat-item"><div class="cap-stat-label">So với VN-Index cùng kỳ</div><div class="cap-stat-val ${dirClass(vsIndex)}">${vsIndex != null ? `${signed(vsIndex)} điểm %` : '–'}</div><div class="cap-stat-sub">VN-Index ${d.indexPct != null ? `${signed(d.indexPct)}%` : '–'}</div></div>
      <div class="cap-stat-item"><div class="cap-stat-label">Đã chạy</div><div class="cap-stat-val">${d.sessions} phiên</div><div class="cap-stat-sub">Mở ${new Date(d.openedAt).toLocaleDateString('vi-VN')} · ${d.decisions} lần ra quyết định${d.lastDate ? ` · phiên gần nhất ${d.lastDate.split('-').reverse().join('/')}` : ''}</div></div>
      <div class="cap-stat-item"><div class="cap-stat-label">Lệnh đã đóng</div><div class="cap-stat-val">${d.closed.n ? `${d.closed.wins}/${d.closed.n} thắng` : 'Chưa có'}</div><div class="cap-stat-sub">Lãi đã chốt ${vnd(d.closed.pnl)} · phí ${vnd(d.fees)}</div></div>
    </div>
    ${d.sessions < 120 ? `<p class="muted small" style="margin-top:10px">Mới chạy ${d.sessions} phiên: kết quả lúc này chủ yếu là may rủi. Cần khoảng 120–250 phiên (6–12 tháng) và so với VN-Index mới đánh giá được tool.</p>` : ''}`;

  const pendRows = d.pending.map((p) => `<tr>
      <td><span class="st-badge ${p.side === 'BUY' ? 'up' : 'down'}">${p.side === 'BUY' ? 'MUA' : 'BÁN'}</span></td>
      <td><a href="#${esc(p.symbol)}" class="pf-sym" data-sym="${esc(p.symbol)}"><b>${esc(p.symbol)}</b></a></td>
      <td>${p.side === 'BUY' ? `~${fmt(p.estShares, 0)} cp` : `${fmt(p.shares, 0)} cp`}</td>
      <td>${fmt(p.estPrice)}</td>
      <td>${p.side === 'BUY' ? vnd(p.budget) : '–'}</td>
      <td style="font-family:inherit">${esc(AT_REASON[p.reason] || p.reason || '')}</td></tr>`).join('');
  const holdRows = d.holdings.map((h) => `<tr>
      <td><a href="#${esc(h.symbol)}" class="pf-sym" data-sym="${esc(h.symbol)}"><b>${esc(h.symbol)}</b></a>${h.selling ? ' <span class="st-badge down">chờ bán</span>' : ''}</td>
      <td>${fmt(h.shares, 0)}</td><td>${fmt(h.avgPrice)}</td><td>${fmt(h.price)}${h.live ? ' <span class="muted small">(trong phiên)</span>' : ''}</td>
      <td>${vnd(h.value)}</td>
      <td class="${dirClass(h.pnl)}">${h.pnl >= 0 ? '+' : ''}${vnd(h.pnl)}</td><td class="${dirClass(h.pnlPct)}">${signed(h.pnlPct)}%</td>
      <td>${h.entryDate.split('-').reverse().join('/')}</td>
      <td>${h.held} phiên${h.sellable ? '' : ` <span class="muted small">(chờ cổ về: còn ${h.wait} phiên, chưa bán được)</span>`}</td>
      <td>${h.holdLeft ? `còn ${h.holdLeft} phiên` : 'đến hạn xét lại'}</td></tr>`).join('');
  const orderRows = d.orders.map((o) => `<tr>
      <td>${o.date.split('-').reverse().join('/')}</td>
      <td><span class="st-badge ${o.side === 'BUY' ? 'up' : 'down'}">${o.side === 'BUY' ? 'MUA' : 'BÁN'}</span></td>
      <td><a href="#${esc(o.symbol)}" class="pf-sym" data-sym="${esc(o.symbol)}"><b>${esc(o.symbol)}</b></a></td>
      <td>${fmt(o.shares, 0)}</td><td>${fmt(o.price)}</td><td>${vnd(o.value)}</td><td>${vnd(o.fee)}</td>
      <td class="${o.pnl != null ? dirClass(o.pnl) : ''}">${o.pnl != null ? `${o.pnl >= 0 ? '+' : ''}${vnd(o.pnl)} (${signed(o.returnPct)}%)` : '–'}</td>
      <td style="font-family:inherit">${esc(AT_REASON[o.reason] || o.reason || '')}</td></tr>`).join('');
  const tbl = (head, rows, empty) => (rows ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted small">${empty}</p>`);

  $('at-body').innerHTML = `
    <div class="two-col">
    <section class="card">
      <div class="card-head"><div><h3>Lệnh cho phiên tới</h3><div class="muted small">Tool đã quyết định sau giờ đóng cửa; sẽ khớp ở giá mở cửa phiên tới. Giá tham chiếu là giá đóng cửa gần nhất.</div></div></div>
      ${d.gate?.breadth != null ? `<p class="small ${d.gate.gated ? 'down' : 'muted'}" style="margin:0 0 10px">Độ rộng thị trường phiên ${d.gate.date.split('-').reverse().join('/')}: <b>${Math.round(d.gate.breadth * 100)}%</b> số mã trên MA50${d.gate.gated ? ` (dưới ${Math.round(d.gate.min * 100)}%) → <b>tạm dừng mua mới</b>, mã đang giữ vẫn theo luật giữ / bán. Kiểm định 3 năm: dừng mua khi thị trường yếu giúp Sharpe 1,16 → 1,27, sụt tối đa −16,8% → −14,4%.` : ` (≥ ${Math.round(d.gate.min * 100)}%): được mua mới.`}</p>` : ''}
      ${tbl(['Lệnh', 'Mã', 'Số lượng', 'Giá tham chiếu', 'Ngân sách', 'Lý do'], pendRows, d.gate?.gated ? 'Không mua mới phiên tới vì thị trường yếu.' : d.lastDate ? 'Không có lệnh mới cho phiên tới.' : 'Tool sẽ ra lệnh đầu tiên sau giờ đóng cửa phiên giao dịch tới (từ 15:10).')}
    </section>
    <section class="card">
      <div class="card-head"><div><h3>Cổ phiếu đang nắm giữ</h3><div class="muted small">Lãi/lỗ đã trừ phí bán và thuế. Tool mua rải dần: ${d.rules.step > 1 ? `ra quyết định ${d.rules.step} phiên/lần` : `xét mỗi phiên, mua mới tối đa ${d.rules.maxNew} mã/phiên`}, mỗi mã giữ ${d.rules.hold} phiên rồi xét lại (còn là ứng viên thì giữ tiếp, không thì bán). Cổ mua phiên T về tài khoản chiều T+2, sớm nhất bán ở phiên T+${d.rules.sellAfter}.</div></div></div>
      ${tbl(['Mã', 'SL', 'Giá vốn', 'Giá hiện tại', 'Giá trị', 'Lãi/lỗ', '%', 'Ngày mua', 'Đã giữ', 'Hạn xét lại'], holdRows, 'Chưa nắm giữ mã nào.')}
    </section>
    </div>
    ${d.equity.length >= 2 ? `<section class="card"><div class="card-head"><div><h3>Tài sản so với VN-Index</h3><div class="muted small">Cùng mốc 100 tại phiên đầu tiên</div></div></div><div id="at-chart" style="height:260px"></div></section>` : ''}
    <section class="card">
      <div class="card-head"><div><h3>Sổ lệnh đã khớp</h3><div class="muted small">Ghi lại mọi lệnh tool đã mua / bán, không bao giờ sửa.</div></div></div>
      ${tbl(['Ngày', 'Lệnh', 'Mã', 'SL', 'Giá', 'Giá trị', 'Phí', 'Lãi/lỗ', 'Lý do'], orderRows, 'Chưa có lệnh nào được khớp.')}
      ${d.unfilled.length ? `<details class="disclosure"><summary>Lệnh không khớp (${d.unfilled.length})</summary><ul class="pk-none-list">${d.unfilled.map((u) => `<li><b>${esc(u.symbol)}</b> <span class="muted">${u.date.split('-').reverse().join('/')} · ${u.side === 'BUY' ? 'mua' : 'bán'}: ${esc(u.why)}</span></li>`).join('')}</ul></details>` : ''}
      ${d.cashFlows.length ? `<details class="disclosure"><summary>Nạp / rút theo vốn thực nạp ròng (${d.cashFlows.length})</summary><ul class="pk-none-list">${d.cashFlows.map((c) => `<li><b class="${dirClass(c.amount)}">${c.amount > 0 ? '+' : ''}${vnd(c.amount)}</b> <span class="muted">${c.date.split('-').reverse().join('/')} · ${esc(c.note)}</span></li>`).join('')}</ul></details>` : ''}
    </section>`;
  if (d.equity.length >= 2) renderAutoChart(d.equity);
}

function renderAutoChart(eq) {
  const el = $('at-chart');
  if (!el || !window.LightweightCharts) return;
  const LC = window.LightweightCharts;
  const chart = LC.createChart(el, {
    autoSize: true,
    ...CHART_TOUCH,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') }, timeScale: { borderColor: css('--axis') },
    localization: { locale: 'vi-VN' },
  });
  const idx0 = eq.find((e) => e.index)?.index;
  // Chỉ số hóa theo vốn để nạp / rút không làm đường tài sản nhảy
  chart.addLineSeries({ color: css('--accent'), lineWidth: 2, title: 'Tool' })
    .setData(eq.map((e) => ({ time: e.date, value: (e.nav / e.funded) * 100 })));
  if (idx0) chart.addLineSeries({ color: css('--muted'), lineWidth: 1, title: 'VN-Index' })
    .setData(eq.filter((e) => e.index).map((e) => ({ time: e.date, value: (e.index / idx0) * 100 })));
  chart.timeScale().fitContent();
}

$('auto-btn')?.addEventListener('click', showAutoTrade);
document.addEventListener('click', async (e) => {
  if (e.target.closest('#at-open')) loadAutoTrade('open');
  else if (e.target.closest('#at-run')) loadAutoTrade('run');
  else if (e.target.closest('#at-reset')) {
    if (confirm('Đặt lại sẽ xóa toàn bộ lịch sử giao dịch của tool tự đầu tư. Tiếp tục?')) loadAutoTrade('reset');
  }
});

// ---------- Bảng rộng → dạng thẻ trên điện thoại ----------
// Gắn nhãn cột (data-label) cho từng ô để CSS hiển thị mỗi hàng thành một thẻ khi màn hình hẹp.
// Bảng ma trận (độ nhạy, dòng tiền theo ngày) và bảng ít cột vẫn giữ dạng bảng cuộn ngang.
const CARD_TABLE_MIN_COLS = 5;
const CARD_TABLE_SKIP = '.bt-sens, .flow-table';

function cardifyTable(table) {
  table.dataset.cards = '1';
  const heads = [...(table.tHead?.rows[0]?.cells || [])].flatMap((th) =>
    Array(th.colSpan || 1).fill(th.textContent.trim()));
  if (heads.length < CARD_TABLE_MIN_COLS || table.matches(CARD_TABLE_SKIP)) return;
  table.classList.add('tbl-cards');
  for (const tr of table.tBodies[0]?.rows || []) {
    const cells = [...tr.cells];
    // Tiêu đề thẻ: ô chứa mã cổ phiếu, nếu không có thì ô đầu tiên không phải số thứ tự
    const title = cells.find((td) => td.querySelector('[data-sym]'))
      || cells.find((td, i) => !(i === 0 && heads[0] === '#'));
    let col = 0;
    for (const td of cells) {
      const label = heads[col] || '';
      const span = td.colSpan || 1;
      td.dataset.label = label;
      if (span >= heads.length - 1) td.classList.add('cell-full');
      else if (label === '#') td.classList.add('cell-idx');
      else if (td === title) td.classList.add('cell-title');
      else if (td.textContent.trim().length > 48) td.classList.add('cell-wide');
      col += span;
    }
  }
}

let cardifyQueued = false;
new MutationObserver(() => {
  if (cardifyQueued) return;
  cardifyQueued = true;
  requestAnimationFrame(() => {
    cardifyQueued = false;
    document.querySelectorAll('#main table.tbl:not([data-cards])').forEach(cardifyTable);
  });
}).observe(document.body, { childList: true, subtree: true });

// ---------- Mobile Navigation Controller ----------
let prevMobileTab = 'watchlist';
function setMobileTab(tab) {
  if (['watchlist', 'market', 'picks'].includes(document.body.dataset.mobileTab)) {
    prevMobileTab = document.body.dataset.mobileTab;
  }
  document.body.dataset.mobileTab = tab;
  // Thanh bên dùng chung cho tab "Theo dõi" và "Thị trường" trên di động
  if (tab === 'watchlist') $('side-tab-wl')?.click();
  else if (tab === 'market') $('side-tab-movers')?.click();
  document.querySelectorAll('.mb-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const sheet = $('mobile-more-sheet');
  if (sheet) sheet.hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Đồng bộ thanh dưới cùng với trang đang hiển thị (kể cả khi mở bằng link #xep-hang, #danh-muc…).
// Ngành / Xếp hạng / Danh mục nằm trong menu "Thêm" nên tô sáng nút "Thêm".
function markMobileView(mobileTab, navTab) {
  document.body.dataset.mobileTab = mobileTab;
  document.querySelectorAll('.mb-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === navTab);
  });
}

function initMobileNav() {
  document.body.dataset.mobileTab = 'analyze';

  $('mb-nav-analyze')?.addEventListener('click', () => {
    setMobileTab('analyze');
    if ($('report') && !$('report').hidden) {
      // Đang hiển thị báo cáo phân tích
    } else if (state.current?.symbol) {
      $('picks').hidden = true;
      $('sectorview').hidden = true;
      $('rankview').hidden = true;
      $('portfolio').hidden = true;
      $('autoview').hidden = true;
      $('marketview').hidden = true;
      $('report').hidden = false;
    } else {
      showPicks();
    }
  });

  $('mb-nav-watchlist')?.addEventListener('click', () => {
    setMobileTab('watchlist');
    renderWatchlist();
  });

  $('mb-nav-market')?.addEventListener('click', () => {
    window.scrollTo({ top: 0 });
    showMarket();
  });

  $('mb-nav-picks')?.addEventListener('click', () => {
    setMobileTab('picks');
    showPicks();
  });

  $('mb-nav-more')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = false;
  });

  $('sheet-close')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
  });

  $('sheet-backdrop')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
  });

  $('mb-btn-sector')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    setMobileTab('analyze');
    showSectors();
  });

  $('mb-btn-rank')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    setMobileTab('analyze');
    showRankView();
  });

  $('mb-btn-auto')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    setMobileTab('analyze');
    showAutoTrade();
  });

  $('mb-btn-pf')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    setMobileTab('analyze');
    showPortfolio();
  });

  $('mb-btn-alerts')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    const drawer = $('drawer');
    if (drawer) drawer.hidden = false;
  });

  $('mb-btn-random')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    $('btn-random-stock')?.click();
  });

  $('mb-btn-ai-check')?.addEventListener('click', () => {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.hidden = true;
    $('btn-ai-check')?.click();
  });

  $('mobile-back-btn')?.addEventListener('click', () => {
    setMobileTab(prevMobileTab || 'watchlist');
  });
}

// Khởi tạo điều hướng Mobile, Rules Modal & Bảng Quét Sidebar
initMobileNav();
setupRulesModal();
setupSidebarScanEvents();
loadStockNames().then(() => loadRankBoard());

// Làm mới định kỳ mỗi 2 phút
setInterval(() => {
  loadWatchlist();
  loadAlerts();
  loadMarket();
  loadMarketRegime();
  loadMovers();
  loadRankBoard();
}, 120_000);
