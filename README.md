# VN Stock Advisor

Công cụ theo dõi và phân tích cổ phiếu sàn HOSE (giá trị giao dịch ≥ 5 tỷ/phiên) chạy trên máy cá nhân:
lấy giá, chỉ số tài chính và tin tức từ nguồn công khai, chấm điểm theo 3 nhóm rồi đưa ra khuyến nghị
**NÊN MUA / CÂN NHẮC MUA / THEO DÕI / CHƯA NÊN MUA / TRÁNH-BÁN** kèm lý do cụ thể.

> ⚠ Kết quả chỉ mang tính tham khảo, **không phải lời khuyên đầu tư**. Quy tắc chấm điểm là cố định,
> đơn giản và không biết những gì không có trong dữ liệu (tin nội bộ, kế hoạch phát hành, ngành đặc thù…).

## Cài đặt & chạy

Yêu cầu Node.js ≥ 20. Không cần `npm install` vì tool không dùng thư viện ngoài.

```bash
npm start            # mở http://localhost:3000
npm run scan         # phân tích danh mục theo dõi ngay trong terminal
node scan.js FPT HPG # phân tích các mã chỉ định
node scan.js FPT --bt          # kèm backtest 3 năm (chiến lược điểm hệ thống)
node scan.js FPT --bt=breakout # score | ma_cross | rsi_reversion | macd | breakout
npm test             # chạy unit test
```

Biến môi trường: `PORT` (mặc định 3000) và `SCAN_MINUTES` (chu kỳ quét danh mục, mặc định 1).

## Bật phân tích AI bằng Gemini

1. Mở https://aistudio.google.com/apikey (đăng nhập Google **trên trình duyệt**), bấm **Create API key**.
   Key miễn phí; không bật thanh toán thì không bao giờ bị tính tiền, hết hạn mức chỉ báo lỗi và chờ sang ngày.
   Gói Gemini Pro trong ứng dụng chat **không** thay cho API key.
2. Mở file `.env` (nếu chưa có thì sao chép từ `.env.example`) và điền `GEMINI_API_KEY=...`
3. Khởi động lại `npm start`. Trên trang mỗi mã bấm **Phân tích AI** (model `gemini-flash-latest`, miễn phí).
   Trong terminal: `node scan.js FPT --ai`

Khi Google quá tải (lỗi 503), tool tự thử lại 2 lần rồi chuyển sang model dự phòng `gemini-flash-lite-latest`.

Gemini nhận toàn bộ dữ liệu đã thu thập (60 phiên giá, chỉ báo, chỉ số tài chính, tối đa 30 tin, điểm theo quy tắc)
và trả về: quyết định **MUA / MUA THĂM DÒ / GIỮ / ĐỨNG NGOÀI / BÁN BỚT / BÁN**, độ tin cậy, hành động cho
người chưa có và người đang nắm giữ, vùng mua, cắt lỗ, các mức chốt lời, tỷ trọng vốn, luận điểm mua/bán,
nhận định tin tức, sự kiện sắp tới, tín hiệu cần theo dõi và nhận xét về điểm theo quy tắc.
Tool tự loại bỏ các mức giá vô lý (cắt lỗ cao hơn giá hiện tại, mục tiêu lệch quá 2 lần…).

- `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`: mặc định là các alias `-latest`, tự lên bản mới nhất của Google.
- `GEMINI_AUTO_SCAN=1`: tự động phân tích AI cả danh mục khi quét định kỳ (mỗi mã tối đa 1 lần/`GEMINI_AUTO_HOURS` giờ)
  và báo khi Gemini đổi quyết định.

> Không ghi email/mật khẩu Google vào bất kỳ file nào trong dự án; tool chỉ cần API key.

## Nhiều nhà cung cấp AI — tự chuyển khi hết hạn mức

Khi Gemini hết hạn mức (lỗi 429), tool tự chuyển: model chính → model nhẹ (hạn mức riêng) → key Gemini thứ 2, 3…
→ Mistral → Groq → OpenRouter → dịch vụ tùy chỉnh chuẩn OpenAI. Nhà cung cấp hết hạn mức được cho "nghỉ"
(2 phút nếu giới hạn theo phút, 3 giờ nếu theo ngày) để các lần gọi sau không mất thời gian thử lại.
Key sai hoặc model không tồn tại thì nghỉ 1 giờ. Code ở [src/llm.js](src/llm.js).

| Biến trong .env | Lấy key ở đâu | Ghi chú |
|---|---|---|
| `GEMINI_API_KEYS` | aistudio.google.com/apikey → **Create API key in new project** | Hạn mức tính theo **project**: key thêm phải ở project khác (hoặc tài khoản Google khác). Nhiều key cách nhau dấu phẩy |
| `MISTRAL_API_KEY` | console.mistral.ai → API Keys (chọn gói **Experiment** miễn phí, cần xác minh số điện thoại) | Ngữ cảnh dài, hạn mức rộng; dữ liệu gói miễn phí có thể được dùng để huấn luyện |
| `GROQ_API_KEY` | console.groq.com/keys | Rất nhanh; giới hạn token/phút thấp nên prompt dài (hội đồng đầu tư) có thể bị từ chối → tool tự bỏ qua |
| `OPENROUTER_API_KEY` | openrouter.ai/settings/keys | Model đuôi `:free`; khoảng 20 lượt/phút, 50 lượt/ngày (1.000 nếu từng nạp 10 USD) |
| `CUSTOM_AI_BASE_URL`, `CUSTOM_AI_MODEL`, `CUSTOM_AI_API_KEY` | Bất kỳ dịch vụ chuẩn OpenAI (Cerebras, DeepSeek, OpenAI, Ollama…) | Ví dụ Ollama: `http://localhost:11434/v1` |

Đổi thứ tự bằng `AI_PROVIDERS=mistral,gemini,groq`. Kiểm tra key: `npm run ai-check` hoặc menu **Test Tools → Kiểm tra API key AI**.
Hạn mức miễn phí của các bên thay đổi thường xuyên; xem trang quản lý của từng nhà cung cấp để biết số hiện tại.

## Tính năng

- **Cổ phiếu tiềm năng** (trang mặc định, nút 🔎 trên thanh trên cùng): quét mọi mã **sàn HOSE** có giá trị giao dịch trung bình
  20 phiên ≥ 5 tỷ/phiên (đổi bằng `SCREEN_FLOORS`, `SCREEN_MIN_VALUE` trong `.env`) → chấm kỹ thuật, cơ bản, khối ngoại và nhận diện setup (bứt phá, xu hướng tăng, điều chỉnh về
  hỗ trợ, hồi phục từ quá bán, tích lũy, khối ngoại gom) → phân tích sâu 14 mã dẫn đầu kèm tin tức, loại mã có tin
  rủi ro → Gemini đánh giá từng mã (mua / mua thăm dò / chờ điểm mua / loại) kèm vùng mua, cắt lỗ, mục tiêu, điều
  kiện mua và rủi ro. Tự quét mỗi ngày giao dịch sau 15:10, lưu ở `data/screener.json`; mất khoảng 1–4 phút.
  Đây là **sàng lọc theo dữ liệu, không phải dự báo chắc chắn**.

- **Chế độ gọn (mặc định)**: mỗi mã chỉ hiện thẻ **Quyết định** và biểu đồ. Thẻ gộp kết luận của Gemini
  (tự chạy khi mở mã, mỗi mức giá 1 lần) với điểm của hệ thống, cho biết hai bên có đồng thuận không, kèm:
  nên làm gì (chưa có / đang nắm giữ), giá mua – cắt lỗ – mục tiêu, 3 điểm cộng, 3 điểm trừ, dòng tiền mua bán
  (VN-Index, số mã tăng/giảm, khối ngoại toàn sàn và của mã), tin đáng chú ý và điều cần theo dõi.
  Nút **Chế độ: Gọn / Đầy đủ** trên thanh trên cùng (hoặc "Xem toàn bộ phân tích chi tiết") để hiện mọi chỉ báo.

- **Phân tích một mã**: biểu đồ nến kèm MA20/50/200, khối lượng, đường cắt lỗ và mục tiêu; chỉ báo RSI, MACD,
  Stochastic, ADX (+DI/−DI), MFI, OBV, phân kỳ RSI, Bollinger, ATR, sức mạnh so với VN-Index;
  P/E, P/B, ROE, tăng trưởng, nợ vay, cổ tức…
- **Tổng hợp nhanh**: mỗi nhóm (xu hướng, động lượng, dòng tiền, khối ngoại, so với VN-Index, thị trường, tin tức)
  được kết luận bằng cách xác nhận chéo nhiều chỉ báo thay vì dựa vào một tín hiệu.
- **Khối ngoại**: biểu đồ mua/bán ròng 20 phiên của từng mã, tính vào điểm kỹ thuật.
- **Tin tức 30 ngày**: gắn nhãn tích cực/tiêu cực, phân nhóm sự kiện (kết quả kinh doanh, giao dịch nội bộ, cổ tức,
  dòng tiền, pháp lý, dự án/M&A, khuyến nghị, diễn biến giá) và **phản ứng giá** của phiên sau khi tin ra.
  Tin lãnh đạo/người thân mua vào được tính tích cực, bán ra tính tiêu cực.
- **Thị trường hôm nay** (thanh bên): top tăng mạnh, giảm mạnh, khối ngoại mua ròng, bán ròng và giá trị giao dịch
  lớn nhất của sàn HOSE (chỉ mã giao dịch ≥ 5 tỷ trong phiên); bấm một mã để phân tích. Mã HNX/UPCoM bị chặn (mở lại bằng `SCREEN_FLOORS=HOSE,HNX,UPCOM`).
- **Danh mục theo dõi**: lưu tại `data/state.json`. Server tự quét lại mỗi phút trong giờ giao dịch.
- **Cảnh báo** (biểu tượng chuông): khi khuyến nghị thay đổi, khi giá vượt hoặc thủng ngưỡng bạn đặt,
  hoặc khi xuất hiện cảnh báo rủi ro mới.

### Nâng cấp tham khảo từ Vibe-Trading

- **🧪 Backtest** (tab trong trang mỗi mã): mô phỏng chiến lược trên 1–4 năm giá theo **luật thị trường Việt Nam**
  (port từ engine `vietnam_equity` của Vibe-Trading, mở rộng cho cả HNX/UPCoM):
  chỉ mua, T+2 (mua phiên N bán sớm nhất phiên N+2), biên độ HOSE ±7% / HNX ±10% / UPCoM ±15% (mở cửa giá trần
  không mua được, giá sàn không bán được), lô 100 cp, bước giá, phí 0,15%/chiều + thuế bán 0,1%, trượt giá 0,1%.
  Tín hiệu tính trên giá đóng cửa, khớp giá mở cửa phiên sau (không nhìn trước tương lai).
  5 chiến lược: **điểm kỹ thuật của chính hệ thống** (kiểm chứng bộ quy tắc chấm điểm), giao cắt MA, RSI quá bán,
  MACD, bứt phá Donchian; tùy chọn cắt lỗ/chốt lời %, tỷ trọng vốn.
  Kết quả: lợi nhuận so với mua & nắm giữ và VN-Index, sụt giảm tối đa, Sharpe, Sortino, Calmar, tỷ lệ thắng,
  profit factor, beta, phí đã trả, số lệnh bị chặn bởi trần/sàn/T+2, đường vốn, lịch sử lệnh.
  **Kiểm định độ tin cậy**: bootstrap 2.000 lần (xác suất có lãi, khoảng lợi nhuận 5–95%), chia 4 giai đoạn
  (walk-forward) và **bảng độ nhạy tham số** ngưỡng mua × bán để phát hiện tối ưu hóa quá mức.
- **⚖️ Hội đồng đầu tư** (tab trong trang mỗi mã, cần Gemini): theo preset `investment_committee` — chuyên viên
  phe mua và phe bán lập luận song song trên cùng dữ liệu, rồi giám đốc đầu tư kiêm quản trị rủi ro bác bỏ luận
  điểm thiếu căn cứ, đối chiếu **kết quả backtest 3 năm** và **hồ sơ rủi ro lịch sử** (biến động, VaR/CVaR 95%,
  sụt giảm, beta) rồi ra quyết định kèm tỷ trọng, vùng mua, cắt lỗ, mục tiêu. 3 lượt gọi Gemini, ~30–90 giây,
  lưu ở `data/committee.json`.
- **💼 Danh mục** (nút trên thanh trên cùng): ghi nhật ký mua/bán → vị thế theo **giá vốn bình quân** (gồm phí),
  lãi/lỗ tạm tính sau phí + thuế, lãi đã chốt, **khối lượng bán được theo T+2** (lô chưa về hiện "chờ về"),
  điểm kỹ thuật và mức cắt lỗ của từng mã (tô đỏ khi giá thủng cắt lỗ).
  **X-quang rủi ro** (theo `risk_xray`): số mã hiệu dụng, tỷ trọng lớn nhất, biến động năm, VaR/CVaR 95% 1 phiên
  (theo % và tiền), sụt giảm tối đa, beta, tương quan trung bình, hệ số đa dạng hóa.
  **Chẩn đoán hành vi** (bản rút gọn của Shadow Account): tỷ lệ thắng, lãi/lỗ trung bình, phát hiện gồng lỗ,
  lãi ăn non lỗ để lâu, lệnh lỗ > 10%, lướt sóng quá nhiều. Lưu ở `data/portfolio.json`.
  Đổi phí môi giới bằng biến `FEE_BROKERAGE` (mặc định 0.0015).

### Xếp hạng 4 yếu tố & đo độ chính xác (nút 🎯 Xếp hạng)

Đánh giá trên 40 mã thanh khoản cao, 2023–2026, chia đôi học/kiểm tra cho thấy **điểm kỹ thuật cũ không dự báo được**
(đúng hướng ~48%, mã "TRÁNH" còn tăng nhiều hơn mã "NÊN MUA"). Bốn yếu tố giữ được khả năng dự báo ở cả hai nửa:
động lượng 12 tháng bỏ tháng gần nhất, khoảng cách tới đỉnh 52 tuần, biến động thấp (ATR%), ADX.

- **Điểm xếp hạng 0–100** ([src/ranking.js](src/ranking.js)): phân vị trung bình của 4 yếu tố so với rổ cổ phiếu HOSE có giá trị giao dịch TB 20 phiên ≥ 5 tỷ (cùng tiêu chí với bộ lọc tiềm năng, ~130 mã). Hiện ở thẻ
  trong trang mỗi mã, trong bảng xếp hạng và trên thẻ cổ phiếu tiềm năng (bộ lọc cũng cộng/trừ tối đa 10 điểm theo xếp hạng).
  ≥ 70 và trên MA200 = nhóm dẫn đầu; < 30 = nhóm đội sổ.
- **Backtest danh mục top N**: mỗi 20 phiên nắm giữ 8 mã điểm cao nhất trên MA200, chia đều vốn, đủ phí/thuế/T+2/trần sàn;
  mỗi kỳ chỉ chọn mã đạt ngưỡng thanh khoản tại thời điểm đó. Rổ HOSE ≥ 5 tỷ: 3 năm +104% so với VN-Index +51%
  (thắng 23/37 kỳ), nhưng 12 tháng gần nhất −7,6% so với −3,4% (thắng 5/12 kỳ). Danh sách mã lấy từ hiện tại nên có
  thiên lệch sống sót — xem số liệu thực tế ở mục dưới.
- **Nhật ký dự đoán** ([src/predictions.js](src/predictions.js), `data/predictions.json`): tự ghi mọi khuyến nghị (hệ thống,
  điểm xếp hạng, top 8 bảng xếp hạng, Gemini, hội đồng, cổ phiếu tiềm năng) và tự chấm sau 5/10/20 phiên bằng giá thật:
  tỷ lệ đúng hướng, tỷ lệ thắng VN-Index, lợi nhuận trung bình — để biết nguồn nào đáng tin.

### Khuyến nghị dựa trên điểm xếp hạng (từ 17/10/2026)

Nhãn NÊN MUA / THEO DÕI / CHƯA NÊN MUA của mỗi mã cổ phiếu giờ dựa trên **điểm xếp hạng 4 yếu tố**, vì đo trên rổ HOSE ≥ 5 tỷ
2022–2026 (chia 2 nửa) chỉ có một nhóm thắng VN-Index ổn định:

| Nhóm | Vượt VN-Index mỗi 20 phiên (2 năm đầu / 2 năm gần) | Khuyến nghị |
|---|---|---|
| Điểm ≥ 70 và giá trên MA200 | +0,7% / +0,9% | **NÊN MUA** |
| Điểm ≥ 70 nhưng dưới MA200 | −1,5% / −1,0% (thắng ~40%) | CHƯA NÊN MUA |
| Điểm 30–69 | lẫn lộn | THEO DÕI |
| Điểm < 30 | +1,0% / −1,8% | CHƯA NÊN MUA |

Bộ lọc chặn: tin rủi ro nghiêm trọng 7 ngày hoặc doanh nghiệp lỗ → hạ NÊN MUA xuống THEO DÕI; thanh khoản dưới ngưỡng → CÂN NHẮC MUA;
nhóm đội sổ kèm tin rủi ro/lỗ → TRÁNH/BÁN. Điểm kỹ thuật/cơ bản/tin tức kiểu cũ vẫn hiển thị nhưng chỉ để tham khảo.
Bộ lọc Cổ phiếu tiềm năng chỉ đưa vào vòng sâu các mã điểm ≥ 70 và trên MA200.

**Lọc theo xu hướng VN-Index đã được thử và không bật**: giảm tỷ trọng khi VN-Index dưới MA200 (hoặc MA50) làm lợi nhuận
3 năm giảm từ +101% xuống +69% (giữ nửa) / +44% (cầm tiền) mà sụt giảm tối đa không nhỏ hơn. Vẫn có tùy chọn trong backtest.

**Ảnh chụp cuối ngày** ([src/history.js](src/history.js)): sau 15:10 mỗi phiên, lưu khối ngoại, chỉ số tài chính, điểm xếp hạng
và điểm cũ của toàn bộ rổ vào `data/history/` (để vài tháng sau kiểm chứng phần cơ bản/khối ngoại), đồng thời ghi dự đoán
của cả hai cách chấm cho **mọi mã** vào nhật ký — so sánh công bằng, không lệch theo mã người dùng mở.

## Cách chấm điểm

Mỗi nhóm cho điểm từ −100 đến +100. Tổng điểm là trung bình có trọng số; nhóm nào thiếu dữ liệu thì bỏ qua.

| Nhóm | Trọng số | Nội dung |
|---|---|---|
| Kỹ thuật | 40% | Vị trí giá so với MA20/50/200, RSI, MACD (kể cả điểm cắt), ADX, Stochastic, MFI, OBV, phân kỳ RSI, Bollinger, khối lượng đột biến, hiệu suất 20 phiên, sức mạnh so với VN-Index, khối ngoại 5/20 phiên, xu hướng VN-Index (tổng điểm nhân 0,75 để về thang ±100) |
| Cơ bản | 35% | P/E, P/B, ROE, tăng trưởng lợi nhuận và doanh thu 4 quý, nợ vay/vốn chủ, tỷ suất cổ tức |
| Tin tức | 25% | Cảm xúc tin theo từ khóa tiếng Việt (có xử lý phủ định); tin mới có trọng số cao hơn (bán rã 7 ngày) |

| Tổng điểm | Khuyến nghị |
|---|---|
| ≥ 35 | NÊN MUA |
| 15 → 34 | CÂN NHẮC MUA |
| −15 → 14 | THEO DÕI |
| −35 → −16 | CHƯA NÊN MUA |
| < −35 | TRÁNH / BÁN |

**Chốt chặn an toàn**: nếu trong 7 ngày có tin rủi ro nghiêm trọng (khởi tố, điều tra, hủy niêm yết,
diện cảnh báo, giải chấp…), khuyến nghị mua sẽ bị hạ xuống THEO DÕI. "Độ đồng thuận" là tỷ lệ số nhóm
cùng chiều với tổng điểm.

Muốn chỉnh ngưỡng hoặc trọng số: sửa `WEIGHTS`, `RECOMMENDATIONS` và các hàm `technicalAnalysis`/`fundamentalAnalysis`
trong [src/analyze.js](src/analyze.js). Muốn thêm từ khóa tin tức: sửa [src/sentiment.js](src/sentiment.js).

## Nguồn dữ liệu

| Dữ liệu | Nguồn |
|---|---|
| Giá ngày | VNDirect dchart → VPS → SSI (tự chuyển nguồn khi lỗi) |
| Chỉ số tài chính, thông tin công ty | VNDirect finfo API |
| Tin tức | Google News RSS (tìm theo mã), CafeF RSS, Vietstock RSS |

Đây là các API công khai, không chính thức, nên có thể thay đổi hoặc bị chặn bất cứ lúc nào.
Giá cổ phiếu tính bằng **nghìn đồng**.

## Cấu trúc

```
server.js          Web server + API (/api/analyze/:mã, /api/market, /api/watchlist, /api/alerts, /api/scan,
                   /api/backtest/:mã, /api/committee/:mã, /api/portfolio)
scan.js            Phân tích từ dòng lệnh
src/data.js        Lấy giá, chỉ số tài chính
src/news.js        Thu thập và lọc tin RSS
src/sentiment.js   Chấm điểm cảm xúc tin tiếng Việt
src/indicators.js  SMA, EMA, RSI, MACD, Bollinger, ATR
src/analyze.js     Chấm điểm và đưa ra khuyến nghị
src/tracker.js     Danh mục theo dõi, quét định kỳ, cảnh báo
src/backtest.js    Engine backtest luật VN, chiến lược, chỉ số hiệu quả, bootstrap, walk-forward
src/risk.js        VaR/CVaR, biến động, beta, tương quan
src/committee.js   Hội đồng đầu tư Gemini (phe mua / phe bán / giám đốc đầu tư)
src/portfolio.js   Nhật ký lệnh, vị thế, T+2, X-quang rủi ro, chẩn đoán hành vi
public/            Giao diện web
test/              Unit test
```
