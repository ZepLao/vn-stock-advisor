-- Database phân tích của VN Stock Advisor. App tự chạy file này khi khởi động (an toàn khi chạy lại).
-- Dữ liệu gốc vẫn nằm trong data/*.json; database giữ bản sao đầy đủ và MỌI phiên bản (file JSON chỉ giữ bản mới nhất).

-- Thị trường mỗi phiên (từ ảnh chụp cuối ngày)
CREATE TABLE IF NOT EXISTS market_daily (
  date         date PRIMARY KEY,
  close        numeric,
  change_pct   numeric,
  trend        text,
  ma50         numeric,
  ma200        numeric,
  above_ma200  boolean,
  return_20d   numeric,
  universe     int,
  raw          jsonb
);

-- Toàn bộ rổ cổ phiếu mỗi phiên: điểm xếp hạng, điểm cũ, khối ngoại, chỉ số tài chính tại thời điểm đó
CREATE TABLE IF NOT EXISTS stock_daily (
  date              date,
  symbol            text,
  close             numeric,
  value20           numeric,
  rank_score        int,
  above_ma200       boolean,
  rank_rec          text,
  tech_score        int,
  fund_score        int,
  legacy_total      int,
  legacy_rec        text,
  f_mom             numeric,
  f_high            numeric,
  f_atr             numeric,
  f_adx             numeric,
  foreign_net1      numeric,
  foreign_net5      numeric,
  foreign_net20     numeric,
  foreign_ratio20   numeric,
  pe                numeric,
  pb                numeric,
  roe               numeric,
  eps_ttm           numeric,
  profit_growth_ttm numeric,
  revenue_growth_ttm numeric,
  debt_to_equity    numeric,
  dividend_yield    numeric,
  report_date       date,
  raw               jsonb,
  PRIMARY KEY (date, symbol)
);

-- Giá ngày (OHLCV) của rổ + VNINDEX, dùng để chấm dự đoán ngay trong SQL
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol  text,
  date    date,
  open    numeric,
  high    numeric,
  low     numeric,
  close   numeric,
  volume  numeric,
  PRIMARY KEY (symbol, date)
);

-- Nhật ký dự đoán (mọi nguồn: xếp hạng, hệ thống, AI, hội đồng, quyết định cuối, cổ phiếu tiềm năng)
CREATE TABLE IF NOT EXISTS predictions (
  source       text,
  symbol       text,
  date         date,
  direction    smallint,
  label        text,
  price        numeric,
  detail       text,
  recorded_at  timestamptz,
  PRIMARY KEY (source, symbol, date)
);

-- Sổ dự đoán CHỈ GHI THÊM (data/prediction_log.jsonl): mọi lần ghi, kèm phiên bản mô hình và số liệu định lượng.
-- Bảng predictions ở trên giữ bản ghi được chấm (cuối cùng trước 9:00 phiên sau) cho các view.
CREATE TABLE IF NOT EXISTS prediction_log (
  id           uuid PRIMARY KEY,
  source       text,
  symbol       text,
  date         date,
  direction    smallint,
  label        text,
  price        numeric,
  detail       text,
  score        numeric,
  confidence   numeric,
  band         jsonb,
  plan         jsonb,
  partial      boolean,
  version      text,
  recorded_at  timestamptz
);
CREATE INDEX IF NOT EXISTS prediction_log_key ON prediction_log (source, symbol, date);
ALTER TABLE prediction_log ADD COLUMN IF NOT EXISTS expected jsonb;
ALTER TABLE prediction_log ADD COLUMN IF NOT EXISTS expected_excess jsonb;
ALTER TABLE prediction_log ADD COLUMN IF NOT EXISTS flags jsonb;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS version text;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score numeric;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS confidence numeric;

-- Mỗi lần AI (Gemini…) phân tích một mã: giữ tất cả phiên bản
CREATE TABLE IF NOT EXISTS ai_analyses (
  symbol          text,
  created_at      timestamptz,
  price_date      date,
  price           numeric,
  model           text,
  decision        text,
  decision_label  text,
  confidence      int,
  final_code      text,
  final_label     text,
  final_relation  text,
  forecast        jsonb,
  raw             jsonb,
  PRIMARY KEY (symbol, created_at)
);

-- Mỗi lần hội đồng đầu tư họp
CREATE TABLE IF NOT EXISTS committee_runs (
  symbol      text,
  created_at  timestamptz,
  price_date  date,
  price       numeric,
  model       text,
  decision    text,
  final_code  text,
  final_label text,
  raw         jsonb,
  PRIMARY KEY (symbol, created_at)
);

-- Kịch bản giá AI (5/10/20 phiên) và dải thống kê 5–95% lúc dự báo
CREATE TABLE IF NOT EXISTS forecasts (
  symbol       text,
  date         date,
  close        numeric,
  source       text,
  recorded_at  timestamptz,
  scenarios    jsonb,
  expected     jsonb,
  band         jsonb,
  PRIMARY KEY (symbol, date)
);

-- Phe mua / phe bán chủ động cả phiên
CREATE TABLE IF NOT EXISTS order_flow (
  symbol          text,
  date            date,
  buy             numeric,
  sell            numeric,
  auction         numeric,
  big_buy         numeric,
  big_sell        numeric,
  big_buy_count   int,
  big_sell_count  int,
  ticks           int,
  buy_ratio       numeric,
  big_buy_ratio   numeric,
  captured_at     timestamptz,
  PRIMARY KEY (symbol, date)
);

-- Mỗi lần quét cổ phiếu tiềm năng
CREATE TABLE IF NOT EXISTS screener_runs (
  created_at  timestamptz PRIMARY KEY,
  date        date,
  candidates  jsonb,
  raw         jsonb
);

-- Bản tin Telegram đã gửi
CREATE TABLE IF NOT EXISTS telegram_reports (
  id          bigserial PRIMARY KEY,
  sent_at     timestamptz DEFAULT now(),
  kind        text,
  text        text,
  unverified  text[]
);

-- Cảnh báo trong phiên
CREATE TABLE IF NOT EXISTS alerts (
  id       text PRIMARY KEY,
  time     timestamptz,
  symbol   text,
  type     text,
  message  text
);

-- Giao dịch thật trong Danh mục (bản sao đúng như file, kể cả khi xóa)
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id      text PRIMARY KEY,
  seq     int,
  type    text,
  symbol  text,
  qty     numeric,
  price   numeric,
  date    date,
  note    text
);

-- Gợi ý mua đã gửi Telegram (pick) và mã AI loại (rejected), để tự đánh giá
CREATE TABLE IF NOT EXISTS trades (
  symbol      text,
  date        date,
  status      text,
  code        text,
  entry       numeric,
  stop        numeric,
  target      numeric,
  buy_from    numeric,
  buy_to      numeric,
  recorded_at timestamptz,
  PRIMARY KEY (symbol, date)
);

-- Mỗi lần tự đánh giá
CREATE TABLE IF NOT EXISTS self_reviews (
  date    date,
  at      timestamptz PRIMARY KEY,
  raw     jsonb
);

-- Nhật ký tự chỉnh thông số
CREATE TABLE IF NOT EXISTS tuning_log (
  at        timestamptz PRIMARY KEY,
  date      date,
  name      text,
  from_val  jsonb,
  to_val    jsonb,
  reason    text,
  evidence  jsonb
);

-- Chấm dự đoán: mua giá MỞ CỬA phiên sau ngày dự đoán, bán giá đóng cửa phiên thứ h; so với VN-Index và rổ cùng cách tính
-- (NULL khi chưa đủ phiên). Thiếu giá mở cửa thì dùng đóng cửa ngày dự đoán.
CREATE OR REPLACE VIEW prediction_scores AS
WITH b AS (
  SELECT symbol, date, close, row_number() OVER (PARTITION BY symbol ORDER BY date) AS n FROM daily_bars
), p AS (
  SELECT pr.*, b.n FROM predictions pr JOIN b ON b.symbol = pr.symbol AND b.date = pr.date
), i AS (
  SELECT date, close, n FROM b WHERE symbol = 'VNINDEX'
), h AS (
  SELECT * FROM (VALUES (5), (10), (20)) AS h(h)
), ew AS (
  -- Lãi đồng tỷ trọng cả rổ (lịch phiên theo VN-Index): công bằng hơn VN-Index khi vài mã vốn hóa lớn kéo chỉ số
  SELECT i0.date, h.h, avg(c1.close / coalesce(nullif(o1.open, 0), c0.close) - 1) AS ret
  FROM i i0 CROSS JOIN h
  JOIN i in1 ON in1.n = i0.n + 1
  JOIN i i1 ON i1.n = i0.n + h.h
  JOIN daily_bars c0 ON c0.date = i0.date AND c0.symbol <> 'VNINDEX' AND c0.close > 0
  LEFT JOIN daily_bars o1 ON o1.symbol = c0.symbol AND o1.date = in1.date
  JOIN daily_bars c1 ON c1.symbol = c0.symbol AND c1.date = i1.date
  WHERE i0.date IN (SELECT DISTINCT date FROM predictions)
  GROUP BY i0.date, h.h HAVING count(*) >= 20
), e AS (
  SELECT p.*, coalesce(nullif(b1.open, 0), b0.close) AS entry
  FROM p JOIN b b0 ON b0.symbol = p.symbol AND b0.n = p.n
  LEFT JOIN daily_bars b1 ON b1.symbol = p.symbol AND b1.date = (SELECT date FROM b WHERE b.symbol = p.symbol AND b.n = p.n + 1)
), ie AS (
  SELECT i0.date, i0.n, coalesce(nullif(x1.open, 0), i0.close) AS entry
  FROM i i0 LEFT JOIN i in1 ON in1.n = i0.n + 1 LEFT JOIN daily_bars x1 ON x1.symbol = 'VNINDEX' AND x1.date = in1.date
)
SELECT e.source, e.symbol, e.date, e.direction, e.label, e.price,
  h.h AS horizon,
  f.close / e.entry - 1 AS ret,
  (f.close / e.entry - 1) - (i1.close / ie.entry - 1) AS excess,
  CASE WHEN e.direction = 0 THEN NULL ELSE sign(f.close - e.entry) = e.direction END AS correct,
  (f.close / e.entry - 1) - ew.ret AS excess_ew
FROM e
CROSS JOIN h
JOIN b f  ON f.symbol = e.symbol AND f.n = e.n + h.h
LEFT JOIN ie ON ie.date = e.date
LEFT JOIN i i1 ON i1.n = ie.n + h.h
LEFT JOIN ew ON ew.date = e.date AND ew.h = h.h;

-- Tổng hợp độ chính xác theo nguồn và khung thời gian
CREATE OR REPLACE VIEW prediction_accuracy AS
SELECT source, horizon,
  count(*) FILTER (WHERE direction <> 0) AS evaluated,
  round(avg(CASE WHEN correct THEN 1 ELSE 0 END) FILTER (WHERE direction <> 0)::numeric, 3) AS hit_rate,
  round(avg(ret) FILTER (WHERE direction > 0)::numeric, 4) AS buy_avg_return,
  round(avg(excess) FILTER (WHERE direction > 0)::numeric, 4) AS buy_avg_excess,
  round(avg(ret) FILTER (WHERE direction < 0)::numeric, 4) AS sell_avg_return,
  -- Tín hiệu là so với thị trường: mua đúng khi hơn VN-Index, tránh/bán đúng khi kém VN-Index
  round(avg(CASE WHEN sign(excess) = direction THEN 1 ELSE 0 END) FILTER (WHERE direction <> 0 AND excess IS NOT NULL)::numeric, 3) AS beat_index_rate,
  round(avg(excess) FILTER (WHERE direction < 0)::numeric, 4) AS sell_avg_excess,
  -- Cùng cách chấm nhưng so với rổ đồng tỷ trọng
  round(avg(CASE WHEN sign(excess_ew) = direction THEN 1 ELSE 0 END) FILTER (WHERE direction <> 0 AND excess_ew IS NOT NULL)::numeric, 3) AS beat_basket_rate,
  round(avg(excess_ew) FILTER (WHERE direction > 0)::numeric, 4) AS buy_avg_excess_ew,
  round(avg(excess_ew) FILTER (WHERE direction < 0)::numeric, 4) AS sell_avg_excess_ew
FROM prediction_scores
GROUP BY source, horizon
ORDER BY source, horizon;

-- ===== Đối chiếu mọi loại dự đoán với giá thật (src/diagnose.js đọc các view dưới đây) =====
-- Lịch phiên theo VN-Index và lãi đồng tỷ trọng cả rổ sau h phiên: thước đo chung cho mọi phép chấm
CREATE OR REPLACE VIEW basket_returns AS
WITH i AS (SELECT date, row_number() OVER (ORDER BY date) AS n FROM daily_bars WHERE symbol = 'VNINDEX')
SELECT i0.date, h.h, i1.date AS end_date, avg(c1.close / coalesce(nullif(o1.open, 0), c0.close) - 1) AS ret, count(*) AS n,
  in1.date AS next_date
FROM i i0
CROSS JOIN (VALUES (1), (5), (10), (20)) AS h(h)
JOIN i in1 ON in1.n = i0.n + 1
JOIN i i1 ON i1.n = i0.n + h.h
JOIN daily_bars c0 ON c0.date = i0.date AND c0.symbol <> 'VNINDEX' AND c0.close > 0
LEFT JOIN daily_bars o1 ON o1.symbol = c0.symbol AND o1.date = in1.date
JOIN daily_bars c1 ON c1.symbol = c0.symbol AND c1.date = i1.date
WHERE i0.date >= DATE '2026-10-01'
GROUP BY i0.date, h.h, i1.date, in1.date
HAVING count(*) >= 20;

-- Lãi từng mã sau h phiên (mua mở cửa phiên sau, bán đóng cửa phiên thứ h) và phần hơn/kém rổ
CREATE OR REPLACE VIEW fwd_returns AS
SELECT c0.symbol, c0.date, br.h, c0.close AS close0, c1.close AS close_h,
  c1.close / coalesce(nullif(o1.open, 0), c0.close) - 1 AS ret,
  c1.close / coalesce(nullif(o1.open, 0), c0.close) - 1 - br.ret AS excess_ew
FROM basket_returns br
JOIN daily_bars c0 ON c0.date = br.date AND c0.symbol <> 'VNINDEX' AND c0.close > 0
LEFT JOIN daily_bars o1 ON o1.symbol = c0.symbol AND o1.date = br.next_date
JOIN daily_bars c1 ON c1.symbol = c0.symbol AND c1.date = br.end_date;

-- Dải giá và kịch bản của AI (forecasts): giá thật có nằm trong dải 5–95% không, giá kỳ vọng của AI có sát hơn
-- "giá đứng yên" không, kịch bản nào gần giá thật nhất và có phải kịch bản AI cho xác suất cao nhất không
CREATE OR REPLACE VIEW forecast_scores AS
SELECT f.symbol, f.date, f.source, r.h, f.close AS close0, r.close_h AS actual,
  (f.expected ->> ('p' || r.h))::numeric AS expected,
  (f.band -> ('p' || r.h) ->> 0)::numeric AS lo,
  (f.band -> ('p' || r.h) ->> 1)::numeric AS hi,
  r.close_h BETWEEN (f.band -> ('p' || r.h) ->> 0)::numeric AND (f.band -> ('p' || r.h) ->> 1)::numeric AS in_band,
  abs(r.close_h / (f.expected ->> ('p' || r.h))::numeric - 1) AS err_ai,
  abs(r.close_h / f.close - 1) AS err_naive,
  sign((f.expected ->> ('p' || r.h))::numeric - f.close) AS dir_ai,
  sign(r.close_h - f.close) AS dir_actual,
  (SELECT s ->> 'name' FROM jsonb_array_elements(f.scenarios) s
    ORDER BY abs((s ->> ('p' || r.h))::numeric - r.close_h) LIMIT 1) AS nearest_scenario,
  (SELECT s ->> 'name' FROM jsonb_array_elements(f.scenarios) s
    ORDER BY (s ->> 'probability')::numeric DESC NULLS LAST LIMIT 1) AS top_scenario
FROM forecasts f
JOIN fwd_returns r ON r.symbol = f.symbol AND r.date = f.date AND r.h IN (5, 10, 20)
WHERE f.close > 0;

-- Quyết định của Gemini / hội đồng kèm độ tự tin (bản cuối cùng mỗi mã mỗi phiên): tự tin cao có đúng hơn không
CREATE OR REPLACE VIEW ai_confidence_scores AS
WITH a AS (
  SELECT DISTINCT ON (symbol, price_date) 'ai' AS who, symbol, price_date AS date, decision, confidence
  FROM ai_analyses WHERE price_date IS NOT NULL ORDER BY symbol, price_date, created_at DESC
), c AS (
  SELECT DISTINCT ON (symbol, price_date) 'committee' AS who, symbol, price_date AS date, decision,
    (raw -> 'verdict' ->> 'confidence')::int AS confidence
  FROM committee_runs WHERE price_date IS NOT NULL ORDER BY symbol, price_date, created_at DESC
), x AS (SELECT * FROM a UNION ALL SELECT * FROM c)
SELECT x.who, x.symbol, x.date, x.decision, x.confidence, r.h, r.ret, r.excess_ew,
  CASE WHEN x.decision IN ('MUA', 'MUA_THAM_DO') THEN 1 WHEN x.decision IN ('DUNG_NGOAI', 'BAN_BOT', 'BAN') THEN -1 ELSE 0 END AS direction,
  CASE WHEN x.confidence >= 75 THEN 'cao (≥75)' WHEN x.confidence >= 60 THEN 'vừa (60–74)' ELSE 'thấp (<60)' END AS conf_band
FROM x JOIN fwd_returns r ON r.symbol = x.symbol AND r.date = x.date;

-- Mua/bán chủ động cả phiên (order_flow): phe mua áp đảo có báo trước giá hơn rổ không
CREATE OR REPLACE VIEW orderflow_scores AS
SELECT o.symbol, o.date, o.buy_ratio, o.big_buy_ratio, r.h, r.ret, r.excess_ew,
  ntile(3) OVER (PARTITION BY o.date, r.h ORDER BY o.buy_ratio) AS buy_tercile
FROM order_flow o JOIN fwd_returns r ON r.symbol = o.symbol AND r.date = o.date
WHERE o.buy_ratio IS NOT NULL;

-- Hệ số thông tin (IC) từng yếu tố của ảnh chụp cuối ngày (stock_daily): tương quan thứ hạng giữa yếu tố và
-- lãi hơn rổ 10 phiên sau, tính mỗi phiên. IC > 0 đều đặn = yếu tố có giá trị dự báo.
CREATE OR REPLACE VIEW factor_ic AS
WITH s AS (
  SELECT d.date, d.symbol, r.excess_ew, v.factor, v.val
  FROM stock_daily d
  JOIN fwd_returns r ON r.symbol = d.symbol AND r.date = d.date AND r.h = 10
  CROSS JOIN LATERAL (VALUES
    ('rank_score', d.rank_score::numeric), ('legacy_total', d.legacy_total::numeric), ('tech_score', d.tech_score::numeric),
    ('fund_score', d.fund_score::numeric), ('f_mom', d.f_mom), ('f_high', d.f_high), ('f_atr', d.f_atr), ('f_adx', d.f_adx),
    ('foreign_net5', d.foreign_net5), ('foreign_ratio20', d.foreign_ratio20), ('pe', d.pe), ('pb', d.pb), ('roe', d.roe),
    ('profit_growth_ttm', d.profit_growth_ttm)
  ) AS v(factor, val)
  WHERE v.val IS NOT NULL
), rk AS (
  SELECT date, factor, rank() OVER (PARTITION BY date, factor ORDER BY val) AS rv,
    rank() OVER (PARTITION BY date, factor ORDER BY excess_ew) AS rr
  FROM s
)
SELECT date, factor, count(*) AS n, corr(rv, rr) AS ic FROM rk GROUP BY date, factor HAVING count(*) >= 30;

-- Triển vọng tuần của AI (outlook): VN-Index cuối tuần có nằm trong khoảng AI dự báo không (chỉ tuần đã kết thúc)
CREATE OR REPLACE VIEW outlook_scores AS
WITH o AS (
  SELECT date, label, detail,
    replace(substring(detail FROM '^([0-9.,]+)'), ',', '')::numeric AS lo,
    replace(substring(detail FROM '–([0-9.,]+)'), ',', '')::numeric AS hi
  FROM predictions WHERE source = 'outlook' AND detail ~ '^[0-9.,]+–[0-9.,]+'
), w AS (
  SELECT o.*, (SELECT b.close FROM daily_bars b WHERE b.symbol = 'VNINDEX' AND b.date >= o.date
      AND b.date < date_trunc('week', o.date) + interval '7 days' ORDER BY b.date DESC LIMIT 1) AS week_close
  FROM o WHERE date_trunc('week', o.date) + interval '7 days' <= current_date
)
SELECT *, week_close BETWEEN lo AND hi AS in_range FROM w;

-- Nhãn AI lọc tin (src/newsai.js): để đối chiếu với chấm từ khóa và phản ứng giá sau tin
CREATE TABLE IF NOT EXISTS news_labels (
  symbol   text NOT NULL,
  link     text NOT NULL,
  relevant boolean,
  label    text,
  risk     boolean,
  reason   text,
  at       timestamptz,
  PRIMARY KEY (symbol, link)
);

-- Ảnh chụp trong phiên (src/intraday.js, mỗi 15 phút giờ giao dịch): toàn thị trường + toàn bộ rổ cổ phiếu
CREATE TABLE IF NOT EXISTS market_intraday (
  ts          timestamptz PRIMARY KEY,
  date        date,
  vnindex     numeric,
  change_pct  numeric,
  advancers   int,
  decliners   int,
  unchanged   int,
  value       numeric,
  foreign_net numeric
);

CREATE TABLE IF NOT EXISTS stock_intraday (
  ts          timestamptz,
  date        date,
  symbol      text,
  price       numeric,
  change_pct  numeric,
  rank_score  int,
  above_ma200 boolean,
  PRIMARY KEY (ts, symbol)
);
CREATE INDEX IF NOT EXISTS stock_intraday_sym ON stock_intraday (symbol, date);

-- Kết quả chẩn đoán dự đoán mỗi ngày (src/diagnose.js)
CREATE TABLE IF NOT EXISTS diagnostics (
  date  date PRIMARY KEY,
  at    timestamptz,
  raw   jsonb
);

ALTER TABLE news_labels ADD COLUMN IF NOT EXISTS published_at timestamptz;

-- ===== Lịch sử dài cho nghiên cứu (nạp bằng `npm run db-backfill`, chạy lại an toàn) =====

-- Rổ cổ phiếu tại từng thời điểm (mỗi tháng một mốc), gồm cả mã sau này hủy niêm yết: tránh thiên lệch sống sót
CREATE TABLE IF NOT EXISTS universe_snapshots (
  date      date,
  symbol    text,
  exchange  text,
  PRIMARY KEY (date, symbol)
);

-- BCTC theo quý. available_date = ngày cuối quý + 45 ngày (hạn công bố): chỉ được dùng dữ liệu quý từ ngày này
-- trở đi khi kiểm định, để không nhìn trước tương lai. Đơn vị: đồng.
CREATE TABLE IF NOT EXISTS quarterly_financials (
  symbol          text,
  fiscal_date     date,
  available_date  date,
  bank            boolean,
  revenue         numeric,
  gross_profit    numeric,
  profit          numeric,
  cfo             numeric,
  equity          numeric,
  assets          numeric,
  net_interest    numeric,
  provision       numeric,
  PRIMARY KEY (symbol, fiscal_date)
);
CREATE INDEX IF NOT EXISTS quarterly_financials_available ON quarterly_financials (available_date);

-- Khối ngoại mua/bán theo ngày từng mã (đồng)
CREATE TABLE IF NOT EXISTS foreign_daily (
  symbol    text,
  date      date,
  buy_val   numeric,
  sell_val  numeric,
  net_val   numeric,
  net_vol   numeric,
  PRIMARY KEY (symbol, date)
);

-- Kết quả bộ đo 3 rào (npm run evaluate), mỗi lần chạy một dòng
CREATE TABLE IF NOT EXISTS evaluation_runs (
  built_at  timestamptz PRIMARY KEY,
  date_from date,
  date_to   date,
  raw       jsonb
);
